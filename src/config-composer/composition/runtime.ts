import { type ReferenceDiagnostic, hostReferenceStatus } from './reference-diagnostics.ts';
import { type AgentSettings, SettingsError, record } from '../settings.ts';
import { type GlobalPermissionContribution, type PermissionWarning, resolvePermissions } from './permission-runtime.ts';
import { loadComponents } from './components.ts';
import {
  type AgentAvailability,
  availabilityTargets,
  inspectAvailability,
  validateAvailablePrimary,
} from './agent-availability.ts';
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
} from './types.ts';

// The config hook runs before Agent.state can be queried. This catalog supplies identities only;
// OpenCode 1.19.0 still constructs every built-in's prompt, mode, permissions, and other defaults.
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
  permission?: unknown;
  globalPermissions: GlobalPermissionContribution[];
  permissionWarnings: PermissionWarning[];
  agent: Record<string, AgentSettings>;
  model?: string;
  small_model?: string;
  default_agent?: string;
  agentAvailability: Record<string, AgentAvailability>;
  selectedAgents: string[];
  choices: Record<string, ResolvedModelSettings>;
  provenance: Record<string, FieldOrigin>;
  permissions: PermissionContribution[];
  commands: Awaited<ReturnType<typeof loadComponents>>['commands'];
  skillPaths: string[];
  diagnostics: ReferenceDiagnostic[];
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

function mergeAuthored(base: AgentSettings, extra: AgentSettings): AgentSettings {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(extra)])].map((key) => {
      const value = extra[key];
      return [
        key,
        Object.hasOwn(extra, key)
          ? key !== 'permission' && record(value) && record(base[key])
            ? mergeAuthored(base[key], value)
            : value
          : base[key],
      ];
    }),
  );
}

export function resolveConfigurationSettings(
  value: ConfigurationPreset,
  at: FieldOrigin,
  context: {
    presets: Record<string, ConfigurationPreset>;
    globals: { model?: string; small_model?: string };
    provenance: Record<string, FieldOrigin>;
  },
  chain: string[] = [],
): { value: ResolvedModelSettings; fields: Record<string, FieldOrigin> } {
  const { presets, globals, provenance } = context;
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
    const ref = context.provenance[`/configurationPresets/${part(name)}`];
    const inherited = resolveConfigurationSettings(presets[name], ref, context, [...chain, name]);
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

export async function resolveProfileRuntime(
  sources: LoadedSources,
  native: NativeInput,
  overlays: ReadonlyMap<string, string> = new Map(),
): Promise<ResolvedProfileRuntime> {
  const { registry } = sources;
  const diagnostics: ReferenceDiagnostic[] = [];
  const groups = registry.componentGroups ?? {};
  const presets = registry.configurationPresets ?? {};
  const available: Record<string, AgentSettings> = Object.fromEntries(nativeAgentNames.map((name) => [name, {}]));
  Object.assign(available, structuredClone(native.agent ?? {}));
  const components = await loadComponents(sources, available, overlays);
  for (const [name, definition] of Object.entries(registry.components?.agents ?? {})) {
    for (const [index, member] of (definition.skills ?? []).entries()) {
      if (Object.hasOwn(components.skills, member)) {
        continue;
      }
      const status = hostReferenceStatus('skills', member, native.componentInventory);
      if (status !== undefined) {
        diagnostics.push({
          kind: 'skills',
          name: member,
          status,
          agent: name,
          sourceId: sources.provenance[`/components/agents/${part(name)}`].sourceId,
          pointer: `/components/agents/${part(name)}/skills/${index}`,
        });
      }
    }
  }
  Object.assign(available, components.agents);
  for (const [name, value] of Object.entries(native.composerOwnedAgents ?? {})) {
    available[name] = mergeAuthored(available[name] ?? {}, structuredClone(value));
  }
  const commands: Awaited<ReturnType<typeof loadComponents>>['commands'] = {};
  const skillPaths = new Set<string>();
  const agent = structuredClone({ ...native.agent, ...native.composerOwnedAgents });
  const selected = new Set<string>();
  const choices: Record<string, ResolvedModelSettings> = {};
  const authoredBindings = new Map<string, string>();
  const variantOrigins = new Map<string, FieldOrigin>();
  const provenance: Record<string, FieldOrigin> = {};
  const toggled = availabilityTargets(sources, available, diagnostics);
  const availability = new Map<string, boolean>();
  // Explicit workflow decisions retain membership/configuration even when the final agent is disabled.
  for (const name of toggled) {
    available[name].disable = false;
  }
  const permissions: PermissionContribution[] = [];
  const globalPermissions: GlobalPermissionContribution[] = [];
  const globals: { model?: string; small_model?: string } = {};
  for (const key of ['model', 'small_model'] as const) {
    if (native[key] !== undefined) {
      globals[key] = native[key];
      provenance[`/${key}`] = { ...origin(undefined, `/${key}`, 'native'), operation: 'native' };
    }
  }
  for (const [name, value] of Object.entries({ ...native.agent, ...native.composerOwnedAgents })) {
    for (const key of ['model', 'variant', 'disable'] as const) {
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
  function globalSettings(
    value: { model?: string; small_model?: string; permissions?: PermissionRule[] } | undefined,
    at: FieldOrigin,
  ) {
    for (const [index, rule] of (value?.permissions ?? []).entries()) {
      globalPermissions.push({ rule, origin: { ...at, pointer: `${at.pointer}/permissions/${index}/action` } });
    }
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

  function validateSettings(value: AgentConfiguration, at: FieldOrigin) {
    const visited = new Set<string>();
    let current: ConfigurationPreset = value;
    while (current.modelRef?.startsWith('preset:') === true) {
      const name = current.modelRef.slice(7);
      if (visited.has(name) || visited.size >= 32) {
        throw new SettingsError(
          `Model preset reference cycle or depth limit at ${name} (${at.sourceId ?? ''}#${at.pointer}).`,
        );
      }
      if (!Object.hasOwn(presets, name)) {
        throw new SettingsError(`Model preset ${name} does not exist.`);
      }
      visited.add(name);
      current = presets[name];
    }
  }
  for (const [name, value] of Object.entries(presets)) {
    validateSettings(value, sources.provenance[`/configurationPresets/${part(name)}`]);
  }
  const configuredDefinitions: [string, Record<string, { configuration?: AgentConfiguration }>][] = [
    ['components/agents', registry.components?.agents ?? {}],
    ['componentGroups', groups],
  ];
  for (const [kind, definitions] of configuredDefinitions) {
    for (const [name, definition] of Object.entries(definitions)) {
      if (definition.configuration !== undefined) {
        validateSettings(definition.configuration, sources.provenance[`/${kind}/${part(name)}/configuration`]);
      }
    }
  }
  function validateOverrides(value: Record<string, AgentConfiguration> | undefined, at: FieldOrigin) {
    for (const [name, setting] of Object.entries(value ?? {})) {
      validateSettings(setting, { ...at, pointer: `${at.pointer}/agents/${part(name)}` });
    }
  }
  for (const [name, profile] of Object.entries(registry.profiles ?? {})) {
    const at = sources.provenance[`/profiles/${part(name)}`];
    validateOverrides(profile.overrides?.agents, { ...at, pointer: `${at.pointer}/overrides` });
  }
  for (const scope of sources.scopes) {
    if (scope.value.defaults?.agents !== undefined) {
      validateSettings(scope.value.defaults.agents, origin(scope.id, '/defaults/agents', 'defaults'));
    }
    validateOverrides(scope.value.overrides?.agents, origin(scope.id, '/overrides', 'overrides'));
  }
  function diagnoseGroupAgents(name: string, profile: string) {
    for (const [index, member] of (groups[name].agents ?? []).entries()) {
      if (!Object.hasOwn(available, member) || available[member].disable === true) {
        diagnostics.push({
          kind: 'agents',
          name: member,
          status: Object.hasOwn(available, member) ? 'disabled' : 'missing',
          group: name,
          profile,
          sourceId: sources.provenance[`/componentGroups/${part(name)}`].sourceId,
          pointer: `/componentGroups/${part(name)}/agents/${index}`,
        });
      }
    }
  }
  function apply(name: string, value: AgentConfiguration, at: FieldOrigin, explicit = false) {
    const resolved = resolveConfigurationSettings(value, at, {
      presets,
      globals,
      provenance: { ...sources.provenance, ...provenance },
    });
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
      const binding =
        value.modelRef !== undefined
          ? `reference:${value.modelRef}`
          : value.model !== undefined
            ? `model:${value.model}`
            : undefined;
      const changedModel = next.model !== undefined && next.model !== current.model;
      const changedBinding =
        binding !== undefined && authoredBindings.has(name) && authoredBindings.get(name) !== binding;
      if (changedModel || changedBinding) {
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
        // A new same-model binding removes Composer-only values, revealing the
        // original native variant rather than carrying the preceding binding.
        const baseModel =
          available[name].model ?? (name === 'title' ? (native.small_model ?? native.model) : native.model);
        if (
          !changedModel &&
          !pinnedVariant &&
          available[name].variant !== undefined &&
          (baseModel === undefined || baseModel === current.model)
        ) {
          current.variant = available[name].variant;
          agent[name].variant = available[name].variant;
          const path = `/agent/${part(name)}/variant`;
          trace(path, variantOrigins.get(name) ?? { ...origin(undefined, path, 'native'), operation: 'native' });
        }
      }
      if (binding !== undefined) {
        authoredBindings.set(name, binding);
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
  }
  function select(name: string) {
    if (selected.has(name)) {
      return;
    }
    selected.add(name);
    agent[name] = { ...available[name] };
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
        variantOrigins.set(name, provenance[`/agent/${part(name)}/variant`]);
      }
      if ((setting.model !== undefined || setting.modelRef !== undefined) && agent[name].model !== undefined) {
        available[name].model = agent[name].model;
      }
    }
  }
  function overrides(value: Record<string, AgentConfiguration> | undefined, at: FieldOrigin) {
    for (const [name, setting] of Object.entries(value ?? {})) {
      if (!Object.hasOwn(available, name) || available[name].disable === true) {
        diagnostics.push({
          kind: 'agents',
          name,
          status: Object.hasOwn(available, name) ? 'disabled' : 'missing',
          sourceId: at.sourceId,
          pointer: `${at.pointer}/agents/${part(name)}`,
          ...(at.layer.startsWith('profile:') ? { profile: at.layer.slice(8) } : {}),
        });
        continue;
      }
      if (!selected.has(name)) {
        throw new SettingsError(`Agent ${name} must be selected before applying an override.`);
      }
      apply(name, setting, { ...at, pointer: `${at.pointer}/agents/${part(name)}` }, true);
    }
  }
  for (const occurrence of sources.orderedProfiles) {
    for (const [name, enabled] of Object.entries(occurrence.profile.agentAvailability ?? {})) {
      if (!Object.hasOwn(available, name)) {
        continue;
      }
      availability.set(name, enabled);
      trace(`/agent/${part(name)}/disable`, {
        ...occurrence.origin,
        pointer: `${occurrence.origin.pointer}/agentAvailability/${part(name)}`,
        layer: `profile:${occurrence.name}`,
      });
      if (enabled) {
        select(name);
      }
    }
    for (const layer of occurrence.profile.layers ?? []) {
      if (layer.componentGroup !== undefined) {
        const name = layer.componentGroup;
        const group = groups[name];
        for (const key of ['agents', 'commands', 'skills'] as const) {
          for (const [index, member] of (group[key] ?? []).entries()) {
            const status =
              key === 'agents'
                ? !Object.hasOwn(available, member)
                  ? 'missing'
                  : available[member].disable === true
                    ? 'disabled'
                    : undefined
                : Object.hasOwn(components[key], member) ||
                    (key === 'commands' && native.commandNames?.includes(member) === true)
                  ? undefined
                  : hostReferenceStatus(key, member, native.componentInventory);
            if (status !== undefined) {
              diagnostics.push({
                kind: key,
                name: member,
                status,
                group: name,
                profile: occurrence.name,
                sourceId: sources.provenance[`/componentGroups/${part(name)}`].sourceId,
                pointer: `/componentGroups/${part(name)}/${key}/${index}`,
              });
            }
          }
        }
        for (const skill of group.skills ?? []) {
          if (Object.hasOwn(components.skills, skill)) {
            skillPaths.add(components.skills[skill]);
          }
        }
        for (const command of group.commands ?? []) {
          if (Object.hasOwn(components.commands, command)) {
            if (native.commandNames?.includes(command) === true) {
              throw new SettingsError(`Component command ${command} conflicts with an existing native command.`);
            }
            commands[command] = components.commands[command];
          }
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
          const members = resolveGroupAgentNames(group, groups, available);
          diagnoseGroupAgents(group, occurrence.name);
          for (const name of members) {
            target.add(name);
          }
        }
        for (const name of target) {
          if (!Object.hasOwn(available, name) || available[name].disable === true) {
            diagnostics.push({
              kind: 'agents',
              name,
              status: Object.hasOwn(available, name) ? 'disabled' : 'missing',
              profile: occurrence.name,
              sourceId: occurrence.origin.sourceId,
              pointer: `${occurrence.origin.pointer}/layers/${(occurrence.profile.layers ?? []).indexOf(layer)}/target/agents`,
            });
            continue;
          }
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
  for (const [name, enabled] of availability) {
    agent[name] = { ...(Object.hasOwn(agent, name) ? agent[name] : available[name]), disable: !enabled };
  }
  for (const name of Object.keys(available)) {
    const pointer = `/agent/${part(name)}/disable`;
    if (!Object.hasOwn(provenance, pointer)) {
      const component = Object.hasOwn(sources.provenance, `/components/agents/${part(name)}`)
        ? sources.provenance[`/components/agents/${part(name)}`]
        : undefined;
      provenance[pointer] =
        component === undefined
          ? { ...origin(undefined, pointer, 'native availability'), operation: 'native' }
          : { ...component, layer: selected.has(name) ? 'component availability' : 'unselected component' };
    }
  }
  const agentAvailability = inspectAvailability(
    available,
    agent,
    new Set(Object.keys(components.agents)),
    selected,
    provenance,
  );
  validateAvailablePrimary(agentAvailability, native.default_agent);
  for (const [name, command] of Object.entries(commands)) {
    if (
      command.agent !== undefined &&
      (!Object.hasOwn(available, command.agent) ||
        (agent[command.agent] ?? available[command.agent]).disable === true ||
        (Object.hasOwn(components.agents, command.agent) && !selected.has(command.agent)))
    ) {
      diagnostics.push({
        kind: 'agents',
        name: command.agent,
        status: !Object.hasOwn(available, command.agent)
          ? 'missing'
          : (agent[command.agent] ?? available[command.agent]).disable === true
            ? 'disabled'
            : 'unselected',
        command: name,
        sourceId: sources.provenance[`/components/commands/${part(name)}`].sourceId,
        pointer: `/components/commands/${part(name)}/agent`,
      });
      Reflect.deleteProperty(commands, name);
      continue;
    }
  }
  const compiledPermissions = resolvePermissions(native.permission, agent, globalPermissions, permissions, provenance);
  return {
    ...compiledPermissions,
    diagnostics,
    globalPermissions,
    agent,
    commands,
    skillPaths: [...skillPaths],
    ...globals,
    ...(native.default_agent === undefined ? {} : { default_agent: native.default_agent }),
    agentAvailability,
    selectedAgents: [...selected],
    choices,
    provenance,
    permissions,
  };
}
