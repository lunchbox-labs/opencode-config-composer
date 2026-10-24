import { SettingsError, record } from '../settings.ts';
import { nativeAgentSettings, readAgentGroups } from '../membership.ts';
import { agentFields, commandFields, pointer } from './document.ts';
import type {
  CompositionDocument,
  NativeAuthority,
  NativeBaseline,
  Origin,
  ResolvedCandidate,
  Selection,
} from './document-types.ts';
export const builtins: Readonly<Record<string, { mode: string; hidden?: boolean }>> = {
  build: { mode: 'primary' },
  plan: { mode: 'primary' },
  general: { mode: 'subagent' },
  explore: { mode: 'subagent' },
  compaction: { mode: 'primary', hidden: true },
  title: { mode: 'primary', hidden: true },
  summary: { mode: 'primary', hidden: true },
} as const;
export function mergePermission(previous: unknown, incoming: unknown): unknown {
  if (incoming === undefined) {
    return structuredClone(previous);
  }
  if (typeof incoming === 'string') {
    incoming = { '*': incoming };
  }
  if (!record(incoming)) {
    return structuredClone(incoming);
  }
  if (Object.keys(incoming).length === 0 && previous !== undefined) {
    return structuredClone(previous);
  }
  const result: Record<string, unknown> = record(previous)
    ? structuredClone(previous)
    : typeof previous === 'string'
      ? { '*': previous }
      : {};
  for (const [key, value] of Object.entries(incoming)) {
    const prior = Object.hasOwn(result, key) ? result[key] : undefined;
    let policy = value;
    if (record(prior) || record(value)) {
      const patterns: Record<string, unknown> = record(prior)
        ? structuredClone(prior)
        : typeof prior === 'string'
          ? { '*': prior }
          : {};
      for (const [pattern, action] of Object.entries(record(value) ? value : { '*': value })) {
        Reflect.deleteProperty(patterns, pattern);
        Object.defineProperty(patterns, pattern, {
          value: action,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      policy = patterns;
    }
    Reflect.deleteProperty(result, key);
    Object.defineProperty(result, key, {
      value: structuredClone(policy),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}
export function resolveComposition(
  document: CompositionDocument,
  choice: Selection,
  native: NativeBaseline,
  authority: NativeAuthority,
): ResolvedCandidate {
  const profile = choice === undefined ? (document.defaultProfile ?? null) : choice;
  if (profile !== null && !Object.hasOwn(document.profiles, profile)) {
    throw new SettingsError(
      `Saved profile ${profile} does not exist. Choose none, follow default, or another profile. Composer not applied.`,
    );
  }
  const targets = {
    agent: new Set([...Object.keys(builtins), ...Object.keys(native.agent ?? {})]),
    command: new Set(Object.keys(native.command ?? {})),
  };
  const check = (kind: 'agent' | 'command', name: string) => {
    if (!targets[kind].has(name)) {
      throw new SettingsError(`Unknown native ${kind} target ${name}.`);
    }
  };
  for (const layer of [document, ...Object.values(document.profiles)]) {
    for (const kind of ['agent', 'command'] as const) {
      for (const name of Object.keys(layer[kind] ?? {})) {
        check(kind, name);
      }
    }
  }
  // Validate all authored command references, including inactive profiles.
  const validateReference = (patch: unknown) => {
    if (record(patch) && Object.hasOwn(patch, 'agent')) {
      const target = String(patch.agent);
      check('agent', target);
      if (native.agent?.[target]?.disable === true) {
        throw new SettingsError(`Command target ${target} is disabled.`);
      }
    }
  };
  for (const layer of [document, ...Object.values(document.profiles)]) {
    for (const patch of Object.values(layer.command ?? {})) {
      validateReference(patch);
    }
  }
  const result: ResolvedCandidate = { profile, agent: {}, command: {}, memberships: {}, decisions: {} };
  const composer = new Map<string, { value: unknown; origin: Origin }>();
  const assign = (
    kind: 'agent' | 'command',
    name: string,
    patch: Record<string, unknown>,
    origin: Origin,
    authored = false,
  ) => {
    let bindingOrigin: Origin | undefined;
    let bindingVariant = false;
    if (kind === 'agent' && Object.hasOwn(patch, 'model') && result.modelParameters !== undefined) {
      const previous = Object.hasOwn(result.modelParameters, name) ? result.modelParameters[name] : undefined;
      if (origin.kind !== 'frontmatter' || previous?.model !== patch.model) {
        Reflect.deleteProperty(result.modelParameters, name);
      }
    }
    if (
      kind === 'agent' &&
      origin.kind !== 'native' &&
      origin.kind !== 'frontmatter' &&
      typeof patch.modelRef === 'string'
    ) {
      const { modelRef, variant, ...concrete } = patch;
      const selectedModels = profile === null ? undefined : document.profiles[profile].models;
      const selected = Object.hasOwn(selectedModels ?? {}, modelRef);
      const bindings = selected ? selectedModels : document.models;
      const binding = Object.hasOwn(bindings ?? {}, modelRef) ? bindings?.[modelRef] : undefined;
      const referencePointer = `${origin.pointer ?? ''}/modelRef`;
      if (binding === undefined && profile !== null) {
        throw new SettingsError(
          `${referencePointer}: Model alias ${JSON.stringify(modelRef)} has no binding in profile ${JSON.stringify(profile)} or root models.`,
        );
      }
      bindingVariant = !Object.hasOwn(patch, 'variant');
      patch =
        binding === undefined
          ? concrete
          : { ...concrete, model: binding.model, variant: variant ?? binding.variant ?? '' };
      if (binding !== undefined) {
        bindingOrigin = {
          ...origin,
          pointer: referencePointer,
          modelBinding: {
            name: modelRef,
            pointer: `${selected && profile !== null ? `/profiles/${pointer(profile)}` : ''}/models/${pointer(modelRef)}`,
          },
        };
        const { model, variant: _variant, ...parameters } = binding;
        result.modelParameters ??= {};
        Reflect.deleteProperty(result.modelParameters, name);
        if (Object.keys(parameters).length > 0) {
          Object.defineProperty(result.modelParameters, name, {
            value: { model, parameters: structuredClone(parameters), origin: bindingOrigin },
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
    }
    const entries = result[kind];
    if (!Object.hasOwn(entries, name)) {
      Object.defineProperty(entries, name, { value: {}, enumerable: true, writable: true, configurable: true });
    }
    for (const [field, value] of Object.entries(patch)) {
      const key = `/${kind}/${pointer(name)}/${pointer(field)}`;
      const previous = composer.get(key);
      if (field === 'permission' && origin.kind !== 'native' && record(value) && Object.keys(value).length === 0) {
        continue;
      }
      const fieldOrigin =
        bindingOrigin !== undefined && (field === 'model' || (field === 'variant' && bindingVariant))
          ? bindingOrigin
          : origin.pointer === undefined
            ? origin
            : { ...origin, pointer: `${origin.pointer}/${pointer(field)}` };
      const allowed: readonly string[] = kind === 'agent' ? agentFields : commandFields;
      const managed = allowed.includes(field);
      if (!managed) {
        Object.defineProperty(entries[name], field, {
          value: structuredClone(value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        continue;
      }
      const final =
        field === 'permission'
          ? mergePermission(
              origin.kind !== 'native' && !composer.has(key)
                ? mergePermission(native.permission, entries[name][field])
                : entries[name][field],
              value,
            )
          : structuredClone(value);
      Object.defineProperty(entries[name], field, {
        value: final,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (origin.kind !== 'native' && origin.kind !== 'frontmatter') {
        composer.set(key, { value: structuredClone(final), origin: fieldOrigin });
      }
      result.decisions[key] = {
        value: structuredClone(final),
        origin: fieldOrigin,
        ...(authored && previous !== undefined && previous.origin.kind !== 'native'
          ? { blockedComposer: { value: previous.value, origin: previous.origin } }
          : {}),
      };
    }
  };
  for (const kind of ['agent', 'command'] as const) {
    for (const [name, value] of Object.entries(native[kind] ?? {})) {
      const patch = kind === 'agent' ? nativeAgentSettings(value) : value;
      assign(kind, name, patch, { kind: 'native' });
    }
  }
  const profilePermission = profile === null ? undefined : document.profiles[profile].permission;
  if (profile !== null && profilePermission !== undefined) {
    for (const name of targets.agent) {
      assign(
        'agent',
        name,
        { permission: profilePermission },
        { kind: 'profile', pointer: `/profiles/${pointer(profile)}` },
      );
    }
  }
  const profileGroups = profile === null ? {} : (document.profiles[profile].groups ?? {});
  for (const name of targets.agent) {
    const authored = Object.hasOwn(authority, name) ? authority[name].groups : undefined;
    const supplied = Object.hasOwn(native.agent ?? {}, name) ? native.agent?.[name] : undefined;
    const declaration =
      authored !== undefined
        ? {
            groups: readAgentGroups(authored.value, authored.source.path),
            origin: { kind: 'frontmatter' as const, source: authored.source.path },
          }
        : supplied !== undefined && Object.hasOwn(supplied, 'groups')
          ? {
              groups: readAgentGroups(supplied.groups, `Native agent ${name}`),
              origin: { kind: 'native' as const, pointer: `/agent/${pointer(name)}/groups` },
            }
          : undefined;
    if (declaration === undefined) {
      continue;
    }
    Object.defineProperty(result.memberships, name, {
      value: declaration,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    for (const groupName of declaration.groups) {
      if (!Object.hasOwn(document.groups, groupName)) {
        throw new SettingsError(`Agent ${name}: unknown group ${groupName}.`);
      }
      assign('agent', name, document.groups[groupName].agent ?? {}, {
        kind: 'group',
        pointer: `/groups/${pointer(groupName)}/agent`,
      });
      if (Object.hasOwn(profileGroups, groupName) && profile !== null) {
        assign('agent', name, profileGroups[groupName].agent ?? {}, {
          kind: 'profile-group',
          pointer: `/profiles/${pointer(profile)}/groups/${pointer(groupName)}/agent`,
        });
      }
    }
  }
  for (const field of ['model', 'small_model', 'default_agent', 'permission'] as const) {
    if (Object.hasOwn(native, field)) {
      Object.assign(result, { [field]: structuredClone(native[field]) });
      if (field === 'model' || field === 'small_model') {
        result.decisions[`/${field}`] = { value: native[field], origin: { kind: 'native' } };
      }
    }
  }
  const layer = (value: typeof document | (typeof document.profiles)[string], origin: Origin) => {
    for (const field of ['model', 'small_model'] as const) {
      if (Object.hasOwn(value, field)) {
        result[field] = value[field];
        result.decisions[`/${field}`] = { value: value[field], origin };
      }
    }
    for (const kind of ['agent', 'command'] as const) {
      for (const [name, patch] of Object.entries<Record<string, unknown>>(value[kind] ?? {})) {
        assign(kind, name, patch, {
          ...origin,
          pointer: `${origin.pointer ?? ''}/${kind}/${pointer(name)}`,
        });
      }
    }
  };
  layer(document, { kind: 'root' });
  if (profile !== null) {
    const selected = document.profiles[profile];
    layer(selected, { kind: 'profile', pointer: `/profiles/${pointer(profile)}` });
  }
  for (const [name, metadata] of Object.entries(authority)) {
    if (!targets.agent.has(name)) {
      throw new SettingsError(`Native frontmatter target ${name} was not loaded by OpenCode. Restart OpenCode.`);
    }
    for (const [field, pin] of Object.entries(metadata.fields)) {
      assign('agent', name, { [field]: pin.value }, { kind: 'frontmatter', source: pin.source.path }, true);
    }
  }
  const viable = (name: string) => {
    const builtin = Object.hasOwn(builtins, name) ? builtins[name] : undefined;
    const agent = result.agent[name] ?? {};
    return (
      targets.agent.has(name) &&
      agent.disable !== true &&
      (agent.hidden ?? (builtin !== undefined && 'hidden' in builtin ? builtin.hidden : false)) !== true &&
      (agent.mode ?? builtin?.mode ?? 'all') !== 'subagent'
    );
  };
  if (typeof native.default_agent === 'string') {
    if (!viable(native.default_agent)) {
      throw new SettingsError(
        `Native default_agent ${native.default_agent} must be enabled, visible and not a subagent.`,
      );
    }
  } else if (![...targets.agent].some(viable)) {
    throw new SettingsError('At least one enabled visible primary agent must remain.');
  }
  return result;
}
