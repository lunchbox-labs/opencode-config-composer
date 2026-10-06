import { type AgentSettings, SettingsError, record } from '../settings.ts';
import { expandIncludes } from '../prompts.ts';
import { loadComponents } from './components.ts';
import { resolveGroupAgentNames } from './membership.ts';
import type { LoadedSources } from './sources.ts';
import type {
  AgentConfiguration,
  ConfigurationParameters,
  ConfigurationPreset,
  FieldOrigin,
  JsonValue,
  NativeInput,
  PermissionRule,
  PromptConfiguration,
} from './types.ts';

// The config hook runs before Agent.state can be queried. This catalog supplies identities only;
// OpenCode 1.18.34 still constructs every built-in's prompt, mode, permissions, and other defaults.
export const nativeAgentNames = ['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary'] as const;
export interface PermissionContribution {
  agent: string;
  rule: PermissionRule;
  origin: FieldOrigin;
}
export interface ResolvedModelSettings {
  model?: string;
  modelRef?: string;
  variant?: string;
  parameters?: ConfigurationParameters;
  permissions?: PermissionRule[];
}
export interface ResolvedProfileRuntime {
  agent: Record<string, AgentSettings>;
  model?: string;
  small_model?: string;
  selectedAgents: string[];
  choices: Record<string, ResolvedModelSettings>;
  provenance: Record<string, FieldOrigin>;
  permissions: PermissionContribution[];
  commands: Awaited<ReturnType<typeof loadComponents>>['commands'];
  skillPaths: string[];
}

function part(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}
function origin(sourceId: string | undefined, pointer: string, layer: string): FieldOrigin {
  return { sourceId, pointer, layer, operation: 'set', references: [], overwritten: [] };
}
function jsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function mergeJson(base: Record<string, JsonValue>, next: Record<string, JsonValue>): Record<string, JsonValue> {
  const result = { ...base };
  for (const [key, value] of Object.entries(next)) {
    result[key] = jsonObject(value) && jsonObject(base[key]) ? mergeJson(base[key], value) : value;
  }
  return result;
}
function mergeParameters(
  base: ConfigurationParameters = {},
  next: ConfigurationParameters = {},
): ConfigurationParameters {
  return {
    ...base,
    ...next,
    ...(base.options !== undefined || next.options !== undefined
      ? {
          options: mergeJson(base.options ?? {}, next.options ?? {}),
        }
      : {}),
  };
}

export async function resolveProfileRuntime(
  sources: LoadedSources,
  native: NativeInput,
  overlays: ReadonlyMap<string, string> = new Map(),
): Promise<ResolvedProfileRuntime> {
  const { registry } = sources;
  const groups = registry.componentGroups ?? {};
  const presets = registry.configurationPresets ?? {};
  const available: Record<string, AgentSettings> = Object.fromEntries(nativeAgentNames.map((name) => [name, {}]));
  Object.assign(available, structuredClone(native.agent ?? {}));
  const components = await loadComponents(sources, available, overlays);
  Object.assign(available, components.agents);
  const commands: Awaited<ReturnType<typeof loadComponents>>['commands'] = {};
  const skillPaths = new Set<string>();
  const agent = structuredClone(native.agent ?? {});
  const selected = new Set<string>();
  const choices: Record<string, ResolvedModelSettings> = {};
  const provenance: Record<string, FieldOrigin> = {};
  const permissions: PermissionContribution[] = [];
  const prompts: Record<
    string,
    { defaults: PromptConfiguration[]; groups: PromptConfiguration[]; explicit: PromptConfiguration[] }
  > = {};
  const globals: { model?: string; small_model?: string } = {};
  for (const key of ['model', 'small_model'] as const) {
    if (native[key] !== undefined) {
      globals[key] = native[key];
      provenance[`/${key}`] = { ...origin(undefined, `/${key}`, 'native'), operation: 'native' };
    }
  }
  for (const [name, value] of Object.entries(native.agent ?? {})) {
    for (const key of ['model', 'variant'] as const) {
      if (value[key] !== undefined) {
        const pointer = `/agent/${part(name)}/${key}`;
        provenance[pointer] = { ...origin(undefined, pointer, 'native'), operation: 'native' };
      }
    }
  }
  function trace(path: string, source: FieldOrigin) {
    const previous = Object.hasOwn(provenance, path) ? provenance[path] : undefined;
    provenance[path] = {
      ...source,
      overwritten: [...source.overwritten, ...(previous === undefined ? [] : [previous])],
    };
  }
  function globalSettings(value: { model?: string; small_model?: string } | undefined, at: FieldOrigin) {
    for (const key of ['model', 'small_model'] as const) {
      if (value?.[key] !== undefined) {
        globals[key] = value[key];
        trace(`/${key}`, { ...at, pointer: `${at.pointer}/${key}` });
      }
    }
  }
  for (const scope of sources.scopes) {
    globalSettings(scope.value.defaults, origin(scope.id, '/defaults', 'defaults'));
  }
  for (const profile of sources.orderedProfiles) {
    globalSettings(profile.profile.overrides, {
      ...profile.origin,
      pointer: `${profile.origin.pointer}/overrides`,
      layer: `profile:${profile.name}`,
    });
  }
  for (const scope of sources.scopes) {
    globalSettings(scope.value.overrides, origin(scope.id, '/overrides', 'overrides'));
  }

  function modelSettings(
    value: ConfigurationPreset,
    at: FieldOrigin,
    chain: string[] = [],
  ): { value: ResolvedModelSettings; fields: Record<string, FieldOrigin> } {
    let base: ResolvedModelSettings = {};
    let fields: Record<string, FieldOrigin> = {};
    let references = at.references;
    if (value.modelRef?.startsWith('preset:') === true) {
      const name = value.modelRef.slice(7);
      if (chain.includes(name) || chain.length >= 32) {
        throw new SettingsError(`Model preset reference cycle or depth limit at ${name}.`);
      }
      if (!Object.hasOwn(presets, name)) {
        throw new SettingsError(`Model preset ${name} does not exist.`);
      }
      const ref = sources.provenance[`/configurationPresets/${part(name)}`];
      const inherited = modelSettings(presets[name], ref, [...chain, name]);
      base = inherited.value;
      fields = inherited.fields;
      references = [
        ...references,
        `${ref.sourceId ?? ''}#${ref.pointer}`,
        ...Object.values(fields).flatMap((field) => field.references),
      ];
    } else if (value.modelRef !== undefined) {
      const field = value.modelRef === 'opencode:model' ? 'model' : 'small_model';
      if (globals[field] === undefined) {
        throw new SettingsError(`${value.modelRef} has no configured model. Set its default or use native fallback.`);
      }
      base = { model: globals[field] };
      fields.model = { ...provenance[`/${field}`] };
      references = [...references, `/${field}`];
    }
    function mark(item: unknown, key: string) {
      if (!record(item)) {
        for (const path of Object.keys(fields).filter((path) => path.startsWith(`${key}/`))) {
          fields[path] = { ...at, pointer: `${at.pointer}/${key}`, operation: 'unset', overwritten: [fields[path]] };
        }
      }
      const previous = Object.hasOwn(fields, key) ? fields[key] : undefined;
      fields[key] = { ...at, pointer: `${at.pointer}/${key}`, overwritten: previous === undefined ? [] : [previous] };
      if (record(item)) {
        for (const [child, next] of Object.entries(item)) {
          mark(next, `${key}/${part(child)}`);
        }
      }
    }
    for (const key of ['model', 'variant', 'parameters'] as const) {
      if (value[key] !== undefined) {
        mark(value[key], key);
      }
    }
    for (const field of Object.values(fields)) {
      field.references = [...new Set([...references, ...field.references])];
    }
    return {
      value: {
        ...base,
        ...value,
        ...(value.model === undefined && base.model !== undefined ? { model: base.model } : {}),
        ...(base.parameters !== undefined || value.parameters !== undefined
          ? { parameters: mergeParameters(base.parameters, value.parameters) }
          : {}),
        permissions: value.permissions,
      },
      fields,
    };
  }
  function apply(name: string, value: AgentConfiguration, at: FieldOrigin, explicit = false) {
    const resolved = modelSettings(value, at);
    const next = resolved.value;
    const current = choices[name] ?? { model: agent[name].model, variant: agent[name].variant };
    if (
      current.model === undefined &&
      next.model === undefined &&
      (next.parameters !== undefined || next.variant !== undefined)
    ) {
      current.model = name === 'title' ? (globals.small_model ?? globals.model) : globals.model;
      if (current.model === undefined && next.parameters !== undefined) {
        throw new SettingsError(`Agent ${name} requires an effective configured model for partial model settings.`);
      }
    }
    const pinnedVariant = !explicit && available[name].variant !== undefined;
    const pinned = typeof available[name].model === 'string' && available[name].model !== '';
    if (!pinned || explicit) {
      if (next.model !== undefined && next.model !== current.model) {
        if (!pinnedVariant) {
          delete current.variant;
        }
        delete current.parameters;
        if (!pinnedVariant) {
          delete agent[name].variant;
        }
        if (!pinnedVariant) {
          trace(`/agent/${part(name)}/variant`, { ...at, operation: 'unset' });
        }
        const prefix = `/agent/${part(name)}/parameters`;
        for (const path of Object.keys(provenance).filter((path) => path.startsWith(`${prefix}/`))) {
          trace(path, { ...at, operation: 'unset' });
        }
        trace(prefix, { ...at, operation: 'unset' });
      }
      if (next.model !== undefined) {
        current.model = next.model;
        agent[name].model = next.model;
        trace(`/agent/${part(name)}/model`, resolved.fields.model);
      }
      if (next.variant !== undefined && !pinnedVariant) {
        current.variant = next.variant;
        agent[name].variant = next.variant;
        trace(`/agent/${part(name)}/variant`, resolved.fields.variant);
      }
      if (next.parameters !== undefined) {
        const clearReplacedChildren = (value: unknown, key: string): void => {
          if (record(value)) {
            for (const [name, child] of Object.entries(value)) {
              clearReplacedChildren(child, `${key}/${part(name)}`);
            }
          } else {
            const prefix = `/agent/${part(name)}/${key}/`;
            for (const path of Object.keys(provenance).filter((path) => path.startsWith(prefix))) {
              trace(path, { ...resolved.fields[key], operation: 'unset' });
            }
          }
        };
        clearReplacedChildren(next.parameters, 'parameters');
        current.parameters = mergeParameters(current.parameters, next.parameters);
        for (const [key, field] of Object.entries(resolved.fields)) {
          if (key === 'parameters' || key.startsWith('parameters/')) {
            trace(`/agent/${part(name)}/${key}`, field);
          }
        }
      }
      if (next.model !== undefined) {
        delete current.modelRef;
      }
      if (next.modelRef !== undefined) {
        current.modelRef = next.modelRef;
      }
      choices[name] = current;
    }
    for (const [index, rule] of (value.permissions ?? []).entries()) {
      permissions.push({ agent: name, rule, origin: { ...at, pointer: `${at.pointer}/permissions/${index}/action` } });
    }
    if (value.prompt !== undefined) {
      prompts[name][explicit ? 'explicit' : at.layer === 'defaults' ? 'defaults' : 'groups'].push(value.prompt);
    }
  }
  function select(name: string) {
    if (selected.has(name)) {
      return;
    }
    selected.add(name);
    agent[name] = { ...available[name] };
    prompts[name] = { defaults: [], groups: [], explicit: [] };
    for (const scope of sources.scopes) {
      if (scope.value.defaults?.agents !== undefined) {
        apply(name, scope.value.defaults.agents, origin(scope.id, '/defaults/agents', 'defaults'));
      }
    }
    const setting = registry.components?.agents?.[name]?.configuration;
    if (setting !== undefined) {
      const at = sources.provenance[`/components/agents/${part(name)}/configuration`];
      apply(name, setting, at, true);
      if (setting.variant !== undefined) {
        available[name].variant = setting.variant;
      }
      if ((setting.model !== undefined || setting.modelRef !== undefined) && agent[name].model !== undefined) {
        available[name].model = agent[name].model;
      }
    }
  }
  function overrides(value: Record<string, AgentConfiguration> | undefined, at: FieldOrigin) {
    for (const [name, setting] of Object.entries(value ?? {})) {
      if (!selected.has(name)) {
        throw new SettingsError(`Agent ${name} must be selected before applying an override.`);
      }
      apply(name, setting, { ...at, pointer: `${at.pointer}/agents/${part(name)}` }, true);
    }
  }
  for (const occurrence of sources.orderedProfiles) {
    for (const layer of occurrence.profile.layers ?? []) {
      if (layer.componentGroup !== undefined) {
        const name = layer.componentGroup;
        const group = groups[name];
        for (const key of ['skills', 'commands', 'prompts'] as const) {
          for (const member of group[key] ?? []) {
            if (!Object.hasOwn(components[key], member)) {
              throw new SettingsError(`Component group ${name} names missing ${key} component ${member}.`);
            }
          }
        }
        for (const skill of group.skills ?? []) {
          skillPaths.add(components.skills[skill]);
        }
        for (const command of group.commands ?? []) {
          commands[command] = components.commands[command];
        }
        const members = resolveGroupAgentNames(name, groups, available);
        const at = { ...sources.provenance[`/componentGroups/${part(name)}`], layer: `profile:${occurrence.name}` };
        for (const member of members) {
          select(member);
          if (groups[name].configuration !== undefined) {
            apply(member, groups[name].configuration, { ...at, pointer: `${at.pointer}/configuration` });
          }
        }
      } else {
        const target = new Set(layer.target.agents ?? []);
        for (const group of layer.target.componentGroups ?? []) {
          for (const name of resolveGroupAgentNames(group, groups, available)) {
            target.add(name);
          }
        }
        for (const name of target) {
          if (!selected.has(name)) {
            throw new SettingsError(
              `Agent ${name} must be selected before assigning preset ${layer.configurationPreset}.`,
            );
          }
          const at = {
            ...sources.provenance[`/configurationPresets/${part(layer.configurationPreset)}`],
            layer: `profile:${occurrence.name}`,
          };
          apply(name, presets[layer.configurationPreset], at);
        }
      }
    }
    overrides(occurrence.profile.overrides?.agents, {
      ...occurrence.origin,
      pointer: `${occurrence.origin.pointer}/overrides`,
      layer: `profile:${occurrence.name}`,
    });
  }
  for (const scope of sources.scopes) {
    overrides(scope.value.overrides?.agents, origin(scope.id, '/overrides', 'overrides'));
  }
  for (const name of selected) {
    const value = agent[name];
    if (typeof value.prompt !== 'string' || value.prompt.trim() === '') {
      continue;
    }
    const operations = prompts[name];
    const policy = operations.explicit.reduce<PromptConfiguration>(
      (previous, value) => ({ ...previous, ...value }),
      {},
    );
    const ordered = [
      ...(policy.inheritDefaults === false ? [] : operations.defaults),
      ...(policy.inheritGroups === false ? [] : operations.groups),
      ...operations.explicit,
    ];
    const parts = [
      ...ordered.flatMap((item) => item.prepend ?? []),
      value.prompt,
      ...ordered.flatMap((item) => item.append ?? []),
    ];
    value.prompt = await expandIncludes(
      parts.map((text) => (/^@[a-z][a-z0-9-]*\//.test(text) ? `{{include:${text}}}` : text)).join('\n\n'),
      registry.sourceDirectories ?? {},
    );
  }
  for (const [name, command] of Object.entries(commands)) {
    if (
      command.agent !== undefined &&
      (!Object.hasOwn(available, command.agent) ||
        available[command.agent].disable === true ||
        (Object.hasOwn(components.agents, command.agent) && !selected.has(command.agent)))
    ) {
      throw new SettingsError(`Command ${name} names unavailable or unselected agent ${command.agent}.`);
    }
    command.template = await expandIncludes(command.template, registry.sourceDirectories ?? {});
  }
  return {
    agent,
    commands,
    skillPaths: [...skillPaths],
    ...globals,
    selectedAgents: [...selected],
    choices,
    provenance,
    permissions,
  };
}
