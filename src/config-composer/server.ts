import type { Config as NativeConfig } from '@opencode-ai/sdk/v2';
import type { Config, Plugin, PluginModule } from '@opencode-ai/plugin';
import { isDeepStrictEqual } from 'node:util';
import { type AgentSettings, type EffectiveChoice, SettingsError, record } from './settings.ts';
import { publishRuntimeBaseline } from './composition/runtime-baseline.ts';
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
  };
  let sources = await loadCompositionSources(context);
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
        if (isDeepStrictEqual(value[key], previous.applied[key])) {
          if (Object.hasOwn(previous.native, key)) {
            result[key] = previous.native[key];
          } else {
            Reflect.deleteProperty(result, key);
          }
        } else if (recursive && record(value[key]) && record(previous.applied[key])) {
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
        output.output = await expandIncludes(output.output, sources.registry.sourceDirectories ?? {});
      }
    },
    config: async (config: Config & Pick<NativeConfig, 'skills'>) => {
      const configured: unknown = config.agent ?? {};
      if (!agentConfigurations(configured)) {
        throw new SettingsError('An agent configuration must be an object.');
      }
      const previous = configurations.get(config);
      const nativeGlobals = restore({ model: config.model, small_model: config.small_model }, previous);
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
      const resolved = await resolveProfileRuntime(nextSources, {
        ...nativeGlobals,
        agent: staged,
        composerOwnedAgents: owned,
      });
      // Staging guard only: OpenCode catches config-hook errors and may continue without Composer.
      // This is not fail-closed enforcement; do not release until failure behavior is integrated.
      if (resolved.permissions.length !== 0) {
        throw new SettingsError(
          'Selected profiles contain permission contributions. This runtime requires the canonical permission compiler before these profiles can be activated.',
        );
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
        paths: [...new Set([...nativePaths, ...resolved.skillPaths])],
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
        native: nativeGlobals,
        applied: { model: config.model, small_model: config.small_model },
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
        addedPaths: new Set(resolved.skillPaths.filter((path) => !nativePaths.includes(path))),
      });
      sources = nextSources;
      publishRuntimeBaseline(
        config,
        options,
        { root: context.root, directory: input.directory },
        nativeGlobals,
        staged,
      );
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
