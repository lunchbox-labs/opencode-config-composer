import { SettingsError, record } from '../settings.ts';
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
  if (typeof incoming === 'string') {
    return { '*': incoming };
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
    Reflect.deleteProperty(result, key);
    Object.defineProperty(result, key, {
      value: structuredClone(value),
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
  for (const group of document.groups) {
    for (const kind of ['agent', 'command'] as const) {
      for (const name of group.members[kind] ?? []) {
        check(kind, name);
      }
    }
  }
  for (const layer of [document, ...Object.values(document.profiles)]) {
    for (const kind of ['agent', 'command'] as const) {
      for (const name of Object.keys(layer[kind] ?? {})) {
        check(kind, name);
      }
    }
  }
  // Validate all authored command references, including inactive profiles and group patches.
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
    for (const group of layer.groups ?? []) {
      validateReference(group.command);
    }
  }
  const result: ResolvedCandidate = { profile, agent: {}, command: {}, decisions: {} };
  const composer = new Map<string, { value: unknown; origin: Origin }>();
  const assign = (
    kind: 'agent' | 'command',
    name: string,
    patch: Record<string, unknown>,
    origin: Origin,
    authored = false,
  ) => {
    const entries = result[kind];
    if (!Object.hasOwn(entries, name)) {
      Object.defineProperty(entries, name, { value: {}, enumerable: true, writable: true, configurable: true });
    }
    for (const [field, value] of Object.entries(patch)) {
      const key = `/${kind}/${pointer(name)}/${pointer(field)}`;
      const previous = composer.get(key);
      if (
        field === 'permission' &&
        origin.kind !== 'native' &&
        !authored &&
        record(value) &&
        Object.keys(value).length === 0
      ) {
        continue;
      }
      const fieldOrigin =
        origin.pointer === undefined ? origin : { ...origin, pointer: `${origin.pointer}/${pointer(field)}` };
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
          ? authored
            ? typeof value === 'string'
              ? { '*': value }
              : structuredClone(value)
            : mergePermission(entries[name][field], value)
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
  const group = (
    patch: { name: string; agent?: Record<string, unknown>; command?: Record<string, unknown> },
    origin: Origin,
  ) => {
    const root = document.groups.find((group) => group.name === patch.name);
    if (root === undefined) {
      throw new SettingsError(`Unknown group ${patch.name}.`);
    }
    const members = root.members;
    for (const kind of ['agent', 'command'] as const) {
      for (const name of members[kind] ?? []) {
        assign(kind, name, patch[kind] ?? {}, { ...origin, pointer: `${origin.pointer}/${kind}` });
      }
    }
  };
  document.groups.forEach((item, index) => group(item, { kind: 'group', pointer: `/groups/${index}` }));
  for (const kind of ['agent', 'command'] as const) {
    for (const [name, value] of Object.entries(native[kind] ?? {})) {
      const patch = Object.fromEntries(
        Object.entries(value).filter(
          ([key, v]) =>
            !(
              kind === 'agent' &&
              ['options', 'permission'].includes(key) &&
              record(v) &&
              Object.keys(v).length === 0 &&
              Object.hasOwn(result[kind][name] ?? {}, key)
            ),
        ),
      );
      assign(kind, name, patch, { kind: 'native' });
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
    selected.groups?.forEach((item, index) =>
      group(item, { kind: 'profile-group', pointer: `/profiles/${pointer(profile)}/groups/${index}` }),
    );
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
