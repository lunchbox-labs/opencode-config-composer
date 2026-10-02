import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import {
  type AgentSettings,
  type EffectiveChoice,
  type NativeModels,
  SettingsError,
  agentGroups,
  record,
  resolveChoice,
} from './settings.ts';
import { loadConfiguration } from './configuration.ts';
import { composePermissions, nativePermission } from './composition/permissions.ts';
import { composePrompts, expandIncludes } from './prompts.ts';
import { resolveNativeDefaults } from './composition/defaults.ts';

function agentConfigurations(value: unknown): value is Record<string, AgentSettings> {
  return record(value) && Object.values(value).every(record);
}

const ConfigComposerPlugin: Plugin = async (_input, options) => {
  let { settings } = await loadConfiguration(options);
  const defaults = new WeakMap<object, { native: NativeModels; applied: NativeModels }>();
  let agents: Partial<Record<string, AgentSettings>> = {};
  let choices: Partial<Record<string, EffectiveChoice>> = {};
  const globalPermissions = new WeakMap<object, { native: unknown; applied: unknown }>();
  const authored = new WeakMap<
    AgentSettings,
    {
      permission?: unknown;
      appliedPermission?: unknown;
      prompt?: string;
      model?: string;
      variant?: string;
      appliedPrompt?: string;
      appliedModel?: string;
      appliedVariant?: string;
    }
  >();
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
        output.output = await expandIncludes(output.output, settings.promptSources);
      }
    },
    config: async (config) => {
      const configured: unknown = config.agent ?? {};
      if (!agentConfigurations(configured)) {
        throw new SettingsError('An agent configuration must be an object.');
      }
      const nextSettings = (await loadConfiguration(options)).settings;
      const { groups, modelPresets } = nextSettings;
      const previousDefaults = defaults.get(config);
      const native: NativeModels = {};
      for (const field of ['model', 'small_model'] as const) {
        const value =
          previousDefaults !== undefined && config[field] === previousDefaults.applied[field]
            ? previousDefaults.native[field]
            : config[field];
        if (value !== undefined) {
          native[field] = value;
        }
      }
      const effective = resolveNativeDefaults(native, nextSettings);
      const context = { modelPresets, native: effective };
      const previousGlobal = globalPermissions.get(config);
      const nativeGlobal =
        previousGlobal !== undefined && config.permission === previousGlobal.applied
          ? previousGlobal.native
          : config.permission;
      const globalPolicy = composePermissions([nativePermission(nativeGlobal), nextSettings.permission ?? {}]);
      const staged = Object.fromEntries(
        Object.entries(configured).map(([name, agent]) => {
          const previous = authored.get(agent);
          return [
            name,
            {
              ...agent,
              ...(previous !== undefined && agent.permission === previous.appliedPermission
                ? { permission: previous.permission }
                : {}),
              ...(previous !== undefined && agent.prompt === previous.appliedPrompt ? { prompt: previous.prompt } : {}),
              ...(previous !== undefined && agent.model === previous.appliedModel ? { model: previous.model } : {}),
              ...(previous !== undefined && agent.variant === previous.appliedVariant
                ? { variant: previous.variant }
                : {}),
            },
          ];
        }),
      );
      for (const [name, override] of Object.entries(nextSettings.agentOverrides ?? {})) {
        if (override.permission !== undefined && !Object.hasOwn(staged, name)) {
          staged[name] = {};
        }
      }
      const permissions = Object.fromEntries(
        Object.entries(staged)
          .filter(([, agent]) => agent.disable !== true)
          .map(([name, agent]) => {
            const layers = agentGroups(agent, groups).flatMap((group) =>
              groups[group].permission === undefined ? [] : [groups[group].permission],
            );
            const override = nextSettings.agentOverrides?.[name]?.permission;
            const explicit = nativePermission(agent.permission);
            return [
              name,
              layers.length > 0 || override !== undefined
                ? composePermissions([globalPolicy, ...layers, explicit, ...(override === undefined ? [] : [override])])
                : agent.permission,
            ];
          }),
      );
      const nextChoices = Object.fromEntries(
        Object.entries(staged)
          .filter(([, agent]) => agent.disable !== true)
          .map(([name, agent]) => [name, resolveChoice(agent, groups, context)]),
      );
      const prompts = await composePrompts(staged, nextSettings);
      // Commit only after every reference and prompt has validated.
      if (effective.model === undefined) {
        delete config.model;
      } else {
        config.model = effective.model;
      }
      if (effective.small_model === undefined) {
        delete config.small_model;
      } else {
        config.small_model = effective.small_model;
      }
      defaults.set(config, { native, applied: effective });
      settings = nextSettings;
      if (settings.permission !== undefined) {
        config.permission = globalPolicy;
        globalPermissions.set(config, { native: nativeGlobal, applied: globalPolicy });
      }
      for (const name of Object.keys(staged)) {
        if (!Object.hasOwn(configured, name)) {
          configured[name] = {};
        }
      }
      config.agent = configured;
      for (const [name, agent] of Object.entries(configured)) {
        if (agent.disable === true) {
          continue;
        }
        if (permissions[name] === undefined) {
          delete agent.permission;
        } else {
          agent.permission = permissions[name];
        }
        if (staged[name].model === undefined) {
          delete agent.model;
        } else {
          agent.model = staged[name].model;
        }
        if (staged[name].variant === undefined) {
          delete agent.variant;
        } else {
          agent.variant = staged[name].variant;
        }
        const choice = nextChoices[name];
        if (choice.source === 'group') {
          agent.model = choice.model;
          if (choice.variant !== undefined) {
            agent.variant = choice.variant;
          }
        }
        if (Object.hasOwn(prompts, name)) {
          agent.prompt = prompts[name];
        }
        authored.set(agent, {
          permission: staged[name].permission,
          appliedPermission: agent.permission,
          prompt: typeof staged[name].prompt === 'string' ? staged[name].prompt : undefined,
          model: staged[name].model,
          variant: staged[name].variant,
          appliedPrompt: typeof agent.prompt === 'string' ? agent.prompt : undefined,
          appliedModel: agent.model,
          appliedVariant: agent.variant,
        });
      }
      agents = configured;
      choices = nextChoices;
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- OpenCode requires a Promise-returning parameter hook.
    'chat.params': async (input, output) => {
      delete output.options.groups;
      const model = input.model;
      const selected = `${model.providerID}/${model.id}`;
      const modelVariants: unknown = 'variants' in model ? model.variants : undefined;
      const variants = record(modelVariants) ? modelVariants : {};
      const message: unknown = input.message;
      const requested = record(message) && typeof message.variant === 'string' ? message.variant : undefined;
      const choice = choices[input.agent];
      // Do not apply a referenced default to a different session-selected model.
      if (
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
