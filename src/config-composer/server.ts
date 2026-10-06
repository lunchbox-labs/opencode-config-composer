import type { Config as NativeConfig } from '@opencode-ai/sdk/v2';
import type { Config, Plugin, PluginModule } from '@opencode-ai/plugin';
import { bundledSkillDirectory, validateBundledSkills } from './bundled-skills.ts';
import { isDeepStrictEqual } from 'node:util';
import { type AgentSettings, type EffectiveChoice, SettingsError, record } from './settings.ts';
import { permissionNotifications } from './composition/permission-warnings.ts';
import { publishRuntimeBaseline } from './composition/runtime-baseline.ts';
import { MembershipValidationError } from './composition/membership.ts';
import { expandIncludes } from './prompts.ts';
import { loadCompositionSources } from './composition/sources.ts';
import { type ResolvedModelSettings, resolveProfileRuntime } from './composition/runtime.ts';
import { filterParameters, mergeOptions, parametersForDispatch, unprotectedOptions } from './composition/parameters.ts';

const ConfigComposerPlugin: Plugin = async (input, options = {}) => {
  if (
    !record(options) ||
    Object.keys(options).some((key) => !['configFile', 'reloadToken'].includes(key)) ||
    (options.configFile !== undefined && typeof options.configFile !== 'string') ||
    (options.reloadToken !== undefined && typeof options.reloadToken !== 'string')
  ) {
    throw new SettingsError('Config Composer plugin options support only configFile and an optional reloadToken.');
  }
  const context = {
    root:
      typeof input.worktree === 'string' && input.worktree !== '' && input.worktree !== '/'
        ? input.worktree
        : typeof input.directory === 'string'
          ? input.directory
          : process.cwd(),
    baseFile: typeof options.configFile === 'string' ? options.configFile : undefined,
    baseExplicit: options.configFile !== undefined,
    // An optional empty installation must expose native state so the editor can create its first source.
    allowEmpty: true,
  };
  await validateBundledSkills();
  let sources: Awaited<ReturnType<typeof loadCompositionSources>> | undefined;
  const notifications = permissionNotifications(input.client);
  let agents: Partial<Record<string, AgentSettings>> = {};
  let choices: Partial<Record<string, EffectiveChoice & ResolvedModelSettings>> = {};
  interface Authored {
    native: Record<string, unknown>;
    applied: Record<string, unknown>;
    owned: boolean;
  }
  const agentSnapshots = new WeakMap<object, Authored>();
  const resources = new WeakMap<
    object,
    { commands: { native: Record<string, unknown>; applied: Record<string, unknown> }; addedPaths: Set<string> }
  >();
  const configurations = new WeakMap<
    object,
    {
      native: Record<string, unknown>;
      applied: Record<string, unknown>;
      added: Set<string>;
      agents: Map<string, Authored>;
    }
  >();
  function agentConfigurations(value: unknown): value is Record<string, AgentSettings> {
    return record(value) && Object.values(value).every(record);
  }
  function commandConfigurations(value: unknown): value is NonNullable<Config['command']> {
    return record(value) && Object.values(value).every((item) => record(item) && typeof item.template === 'string');
  }
  function restore(
    value: Record<string, unknown>,
    previous: { native: Record<string, unknown>; applied: Record<string, unknown> } | undefined,
    recursive = false,
  ): Record<string, unknown> {
    const result = { ...value };
    if (previous !== undefined) {
      for (const key of [...new Set([...Object.keys(previous.native), ...Object.keys(previous.applied)])]) {
        if (
          key === 'permission'
            ? JSON.stringify(value[key]) === JSON.stringify(previous.applied[key])
            : isDeepStrictEqual(value[key], previous.applied[key])
        ) {
          if (Object.hasOwn(previous.native, key)) {
            result[key] = previous.native[key];
          } else {
            Reflect.deleteProperty(result, key);
          }
        } else if (key !== 'permission' && recursive && record(value[key]) && record(previous.applied[key])) {
          const restored = restore(
            value[key],
            {
              native: record(previous.native[key]) ? previous.native[key] : {},
              applied: previous.applied[key],
            },
            true,
          );
          if (Object.keys(restored).length === 0 && !Object.hasOwn(previous.native, key)) {
            Reflect.deleteProperty(result, key);
          } else {
            result[key] = restored;
          }
        }
      }
    }
    return result;
  }
  return {
    'chat.message': async (input, output) => {
      await notifications.session(input.sessionID, output.message.agent);
    },
    'tool.execute.after': async (input, output) => {
      if (input.tool !== 'skill') {
        return;
      }
      if (record(output.metadata) && output.metadata.truncated === true) {
        throw new SettingsError(
          'The skill output was truncated before composition. Reduce its size and load it again.',
        );
      }
      if (output.output.includes('{{include:')) {
        sources ??= await loadCompositionSources(context);
        output.output = await expandIncludes(output.output, sources.registry.sourceDirectories ?? {});
      }
    },
    config: async (config: Config & Pick<NativeConfig, 'skills'>) => {
      // Packaged help stays discoverable even when a source requires migration or repair.
      config.skills = {
        ...config.skills,
        paths: [...new Set([...(config.skills?.paths ?? []), bundledSkillDirectory])],
      };
      const configured: unknown = config.agent ?? {};
      if (!agentConfigurations(configured)) {
        throw new SettingsError('An agent configuration must be an object.');
      }
      const previous = configurations.get(config);
      const nativeGlobals = restore(
        { model: config.model, small_model: config.small_model, permission: config.permission },
        previous,
      );
      const staged: Record<string, AgentSettings> = {};
      const owned: Record<string, AgentSettings> = {};
      for (const [name, value] of Object.entries(configured)) {
        if (!record(value)) {
          throw new SettingsError('An agent configuration must be an object.');
        }
        const saved = previous?.agents.get(name) ?? agentSnapshots.get(value);
        const restored = restore(value, saved, true);
        if (previous?.added.has(name) === true || (previous === undefined && saved?.owned === true)) {
          if (Object.keys(restored).length > 0) {
            owned[name] = restored;
          }
        } else {
          staged[name] = restored;
        }
      }
      const nextSources = await loadCompositionSources(context);
      let resolved: Awaited<ReturnType<typeof resolveProfileRuntime>>;
      try {
        resolved = await resolveProfileRuntime(nextSources, {
          ...nativeGlobals,
          agent: staged,
          composerOwnedAgents: owned,
        });
      } catch (error) {
        if (error instanceof MembershipValidationError) {
          // Expose exact inspection inputs without applying any part of the invalid composition.
          publishRuntimeBaseline(
            config,
            options,
            { root: context.root, directory: input.directory },
            nativeGlobals,
            staged,
          );
        }
        throw error;
      }
      const previousResources = resources.get(config);
      const nativeCommands = restore(config.command ?? {}, previousResources?.commands);
      if (!commandConfigurations(nativeCommands)) {
        throw new SettingsError('Native commands must contain valid templates.');
      }
      for (const name of Object.keys(resolved.commands)) {
        if (Object.hasOwn(nativeCommands, name)) {
          throw new SettingsError(`Component command ${name} conflicts with an existing native command.`);
        }
      }
      const nextCommands = { ...nativeCommands, ...resolved.commands };
      const nativeSkills = config.skills ?? {};
      const nativePaths = (nativeSkills.paths ?? []).filter((path) => previousResources?.addedPaths.has(path) !== true);
      const nextSkills = {
        ...nativeSkills,
        paths: [...new Set([...nativePaths, bundledSkillDirectory, ...resolved.skillPaths])],
      };
      // Validate the complete candidate before mutating host objects.
      for (const key of ['model', 'small_model'] as const) {
        if (resolved[key] === undefined) {
          Reflect.deleteProperty(config, key);
        } else {
          config[key] = resolved[key];
        }
      }
      for (const name of Object.keys(configured)) {
        if (!Object.hasOwn(resolved.agent, name)) {
          Reflect.deleteProperty(configured, name);
        }
      }
      if (resolved.permission === undefined) {
        delete config.permission;
      } else {
        Object.assign(config, { permission: resolved.permission });
      }
      const authored = new Map<string, Authored>();
      for (const [name, value] of Object.entries(resolved.agent)) {
        const existing = configured[name];
        const target = record(existing) ? existing : {};
        for (const key of Object.keys(target)) {
          if (!Object.hasOwn(value, key)) {
            Reflect.deleteProperty(target, key);
          }
        }
        Object.assign(target, value);
        configured[name] = target;
        const snapshot = {
          native: structuredClone(
            Object.hasOwn(staged, name) ? staged[name] : Object.hasOwn(owned, name) ? owned[name] : {},
          ),
          applied: structuredClone(value),
          owned: !Object.hasOwn(staged, name),
        };
        authored.set(name, snapshot);
        agentSnapshots.set(target, snapshot);
      }
      config.agent = configured;
      configurations.set(config, {
        native: structuredClone(nativeGlobals),
        applied: structuredClone({
          model: config.model,
          small_model: config.small_model,
          permission: config.permission,
        }),
        added: new Set(Object.keys(resolved.agent).filter((name) => !Object.hasOwn(staged, name))),
        agents: authored,
      });
      agents = resolved.agent;
      choices = Object.fromEntries(
        Object.entries(resolved.choices).map(([name, value]) => [name, { ...value, source: 'group' }]),
      );
      config.command = nextCommands;
      config.skills = nextSkills;
      resources.set(config, {
        commands: { native: structuredClone(nativeCommands), applied: structuredClone(nextCommands) },
        addedPaths: new Set(
          [bundledSkillDirectory, ...resolved.skillPaths].filter((path) => !nativePaths.includes(path)),
        ),
      });
      sources = nextSources;
      publishRuntimeBaseline(
        config,
        options,
        { root: context.root, directory: input.directory },
        nativeGlobals,
        staged,
      );
      await notifications.applied(resolved.permissionWarnings);
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- OpenCode requires a Promise-returning parameter hook.
    'chat.params': async (input, output) => {
      delete output.options.groups;
      const model = input.model;
      const selected = `${model.providerID}/${model.id}`;
      const modelVariants: unknown = 'variants' in model ? model.variants : undefined;
      const variants = record(modelVariants) ? modelVariants : {};
      const message: unknown = input.message;
      const requestModel = record(message) && record(message.model) ? message.model : undefined;
      // The title hook receives the original user's model/variant, but the host
      // dispatches it with small=true and deliberately skips variant selection.
      const small = input.agent === 'title';
      // Normal requests (including compaction on another model) retain the
      // original user variant under OpenCode's request preparation rules.
      const requested = small
        ? undefined
        : typeof requestModel?.variant === 'string'
          ? requestModel.variant
          : record(message) && typeof message.variant === 'string'
            ? message.variant
            : undefined;
      const choice = choices[input.agent];
      // Validate normal variants, plus the explicit legacy fallback materialized below.
      // Never validate the original worker variant for a small title dispatch.
      if (
        (!small || Object.hasOwn(agents[input.agent]?.options ?? {}, 'reasoningEffort')) &&
        choice !== undefined &&
        (choice.source === 'group' || (choice.modelRef !== undefined && choice.modelRef !== '')) &&
        choice.model === selected
      ) {
        const key = requested ?? choice.variant;
        if (key !== undefined && key !== '' && (!record(variants[key]) || variants[key].disabled === true)) {
          throw new SettingsError(
            'The group model does not support this reasoning variant. Update the agent or group settings.',
          );
        }
      }
      const parameters =
        choice?.model !== undefined && choice.parameters !== undefined
          ? parametersForDispatch(choice.model, selected, choice.parameters)
          : undefined;
      if (parameters !== undefined) {
        const explicit = filterParameters(parameters, model);
        const agent = agents[input.agent];
        // Native temperature/top_p are agent-wide and would leak these model-bound values
        // to a different session selection. Supply only explicit controls at dispatch instead.
        if (explicit.temperature !== undefined && agent?.temperature === undefined) {
          output.temperature = explicit.temperature;
        }
        if (explicit.topP !== undefined && agent?.top_p === undefined && agent?.topP === undefined) {
          output.topP = explicit.topP;
        }
        if (explicit.topK !== undefined) {
          output.topK = explicit.topK;
        }
        if (explicit.maxOutputTokens !== undefined) {
          output.maxOutputTokens = explicit.maxOutputTokens;
        }
        const selectedVariant = small ? undefined : variants[requested ?? choice?.variant ?? ''];
        output.options = mergeOptions(
          output.options,
          unprotectedOptions(explicit.options ?? {}, [
            agent?.options ?? {},
            ...(record(selectedVariant) ? [selectedVariant] : []),
          ]),
        );
      }
      // Small title requests skip native variant selection. Align the built-in fallbacks
      // with the configured model's variant without forwarding stale provider-specific values.
      if (!['title', 'compaction'].includes(input.agent)) {
        return;
      }
      const agent = agents[input.agent];
      if (agent === undefined || !Object.hasOwn(agent.options ?? {}, 'reasoningEffort')) {
        return;
      }
      if (typeof agent.model === 'string' && agent.model !== '' && agent.model !== selected) {
        return;
      }
      const key =
        input.agent === 'compaction' && requested !== undefined && requested !== '' && record(variants[requested])
          ? requested
          : agent.variant;
      const variant = key !== undefined && key !== '' ? variants[key] : undefined;
      delete output.options.reasoningEffort;
      if (record(variant)) {
        Object.assign(output.options, variant);
      }
      delete output.options.groups;
    },
  };
};

export default { id: 'config-composer', server: ConfigComposerPlugin } satisfies PluginModule;
