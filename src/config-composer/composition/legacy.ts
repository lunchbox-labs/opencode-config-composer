import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { configurationPath } from '../configuration.ts';
import {
  type AgentSettings,
  type GroupChoice,
  type GroupOptions,
  type PromptOperations,
  agentGroups,
  readSettings,
  record,
  resolveChoice,
  resolveGroup,
} from '../settings.ts';
import { type PermissionPolicy, composePermissions, nativePermission } from './permissions.ts';
import type { FieldOrigin, NativeInput, ResolvedComposition, SourceDocument } from './types.ts';

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function origin(pointer: string, sourceId?: string): FieldOrigin {
  return {
    ...(sourceId === undefined ? {} : { sourceId }),
    pointer,
    layer: sourceId === undefined ? 'native' : 'legacy',
    operation: sourceId === undefined ? 'native' : 'set',
    references: [],
    overwritten: [],
  };
}

function fields(
  value: unknown,
  pointer: string,
  provenance: Record<string, FieldOrigin>,
  sourceId?: string,
  keyPointer = pointer,
): void {
  if (value === undefined) {
    return;
  }
  if (pointer !== '') {
    provenance[keyPointer] = origin(pointer, sourceId);
  }
  if (record(value) || Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      fields(child, `${pointer}/${escapePointer(key)}`, provenance, sourceId, `${keyPointer}/${escapePointer(key)}`);
    }
  }
}

function groupOrigin(
  source: SourceDocument,
  name: string,
  group: GroupChoice,
  field: 'model' | 'variant',
): FieldOrigin {
  const referenced = group.modelRef !== undefined && (field === 'model' || group.variant === undefined);
  const result = origin(`/agent/groups/${escapePointer(name)}/${referenced ? 'modelRef' : field}`, source.id);
  if (referenced && group.modelRef !== undefined) {
    result.references = [
      group.modelRef.startsWith('preset:')
        ? `/agent/modelPresets/${escapePointer(group.modelRef.slice(7))}/${field}`
        : `/${group.modelRef.slice('opencode:'.length)}`,
    ];
  }
  return result;
}

function replace(provenance: Record<string, FieldOrigin>, pointer: string, next: FieldOrigin): void {
  const previous = provenance[pointer];
  provenance[pointer] = { ...next, overwritten: Object.hasOwn(provenance, pointer) ? [previous] : [] };
}

function modelOrigins(
  agent: AgentSettings,
  pointer: string,
  settings: GroupOptions,
  source: SourceDocument,
  native: NativeInput,
  provenance: Record<string, FieldOrigin>,
): void {
  const context = { modelPresets: settings.modelPresets, native };
  const choice = resolveChoice(agent, settings.groups, context);
  // Explicit pins bypass group reference resolution in the existing runtime.
  if (choice.source === 'agent') {
    return;
  }
  Reflect.deleteProperty(provenance, `${pointer}/variant`);
  for (const name of agentGroups(agent, settings.groups)) {
    const group = settings.groups[name];
    const resolved = resolveGroup(group, context);
    if (
      group.variant !== undefined &&
      group.modelRef?.startsWith('preset:') === true &&
      settings.modelPresets[group.modelRef.slice(7)].variant !== undefined
    ) {
      // Record the referenced candidate before its explicit group override so
      // both it and any earlier group remain in the overwrite chain.
      replace(provenance, `${pointer}/variant`, groupOrigin(source, name, { ...group, variant: undefined }, 'variant'));
    }
    for (const field of ['model', 'variant'] as const) {
      if (resolved[field] !== undefined) {
        replace(provenance, `${pointer}/${field}`, groupOrigin(source, name, group, field));
      }
    }
  }
  if (agent.variant !== undefined) {
    replace(provenance, `${pointer}/variant`, origin(`${pointer}/variant`));
  }
}

function promptOrigins(
  name: string,
  agent: AgentSettings,
  pointer: string,
  settings: GroupOptions,
  source: SourceDocument,
  provenance: Record<string, FieldOrigin>,
): void {
  if (typeof agent.prompt !== 'string' || agent.prompt.trim() === '') {
    return;
  }
  const policy = settings.agentPrompts[name] ?? {};
  const operations: { pointer: string; value: PromptOperations }[] = [];
  if (policy.inheritDefaults !== false) {
    operations.push({ pointer: '/agent/prompts/defaults', value: settings.promptDefaults });
  }
  if (policy.inheritGroups !== false) {
    for (const group of agentGroups(agent, settings.groups)) {
      operations.push({
        pointer: `/agent/groups/${escapePointer(group)}/prompt`,
        value: settings.groups[group].prompt ?? {},
      });
    }
  }
  operations.push({ pointer: `/agent/prompts/overrides/${escapePointer(name)}`, value: policy });
  const references = (field: 'prepend' | 'append'): string[] =>
    operations.flatMap((item) => (item.value[field] ?? []).map((_, index) => `${item.pointer}/${field}/${index}`));
  const prepend = references('prepend');
  const append = references('append');
  if (prepend.length + append.length === 0) {
    return;
  }
  const last = append.at(-1) ?? prepend.at(-1);
  if (last !== undefined) {
    replace(provenance, `${pointer}/prompt`, {
      ...origin(last, source.id),
      operation: 'merge',
      references: [...prepend, `${pointer}/prompt`, ...append],
    });
  }
}

interface PermissionLayer {
  policy: PermissionPolicy;
  pointer: string;
  sourceId?: string;
  shorthand?: boolean;
}

function permissionOrigins(layers: PermissionLayer[]): Map<string, FieldOrigin> {
  let policy: PermissionPolicy = {};
  let root: FieldOrigin | undefined;
  const blocks: Record<string, { origin: FieldOrigin; patterns: Map<string, FieldOrigin> }> = {};
  for (const layer of layers) {
    const nextPolicy = composePermissions([policy, layer.policy]);
    for (const [name, rules] of Object.entries(layer.policy)) {
      const previous = Object.hasOwn(blocks, name) ? blocks[name] : undefined;
      const merging = record(policy[name]) && record(rules);
      const patterns = merging ? new Map(previous?.patterns) : new Map<string, FieldOrigin>();
      const pointer = layer.shorthand === true ? layer.pointer : `${layer.pointer}/${escapePointer(name)}`;
      if (record(rules)) {
        for (const pattern of Object.keys(rules)) {
          const overwritten = patterns.get(pattern);
          patterns.delete(pattern);
          patterns.set(pattern, {
            ...origin(`${pointer}/${escapePointer(pattern)}`, layer.sourceId),
            overwritten: overwritten === undefined ? [] : [overwritten],
          });
        }
      }
      blocks[name] = {
        origin: {
          ...origin(pointer, layer.sourceId),
          ...(merging ? { operation: 'merge' as const } : {}),
          references: [...patterns.values()].map((item) => item.pointer),
          overwritten: previous === undefined ? [] : [previous.origin],
        },
        patterns,
      };
    }
    policy = nextPolicy;
    root = {
      ...origin(layer.pointer, layer.sourceId),
      ...(root === undefined ? {} : { operation: 'merge' as const }),
      references: Object.keys(policy).map((name) => blocks[name].origin.pointer),
      overwritten: root === undefined ? [] : [root],
    };
  }
  // Store blocks and their children in emitted order, with references retaining
  // that same sequence. Removed descendants exist only in overwrite history.
  const result = new Map<string, FieldOrigin>();
  if (root !== undefined) {
    result.set('', root);
  }
  for (const name of Object.keys(policy)) {
    const block = blocks[name];
    const pointer = `/${escapePointer(name)}`;
    result.set(pointer, block.origin);
    for (const [pattern, value] of block.patterns) {
      result.set(`${pointer}/${escapePointer(pattern)}`, value);
    }
  }
  return result;
}

function applyPermissionOrigins(
  provenance: Record<string, FieldOrigin>,
  pointer: string,
  layers: PermissionLayer[],
): void {
  for (const key of Object.keys(provenance)) {
    if (key === pointer || key.startsWith(`${pointer}/`)) {
      Reflect.deleteProperty(provenance, key);
    }
  }
  for (const [suffix, value] of permissionOrigins(layers)) {
    provenance[`${pointer}${suffix}`] = value;
  }
}

function effectivePermissionOrigins(
  source: SourceDocument,
  native: NativeInput,
  settings: GroupOptions,
  provenance: Record<string, FieldOrigin>,
): void {
  const global: PermissionLayer[] = [];
  if (native.permission !== undefined) {
    global.push({
      policy: nativePermission(native.permission),
      pointer: '/permission',
      shorthand: typeof native.permission === 'string',
    });
  }
  if (settings.permission !== undefined) {
    global.push({ policy: settings.permission, pointer: '/agent/permission', sourceId: source.id });
    applyPermissionOrigins(provenance, '/permission', global);
  }
  const names = new Set([...Object.keys(native.agent ?? {}), ...Object.keys(settings.agentOverrides ?? {})]);
  for (const name of names) {
    const agent = native.agent?.[name] ?? {};
    if (agent.disable === true) {
      continue;
    }
    const groups = agentGroups(agent, settings.groups).flatMap((group): PermissionLayer[] => {
      const policy = settings.groups[group].permission;
      return policy === undefined
        ? []
        : [{ policy, pointer: `/agent/groups/${escapePointer(group)}/permission`, sourceId: source.id }];
    });
    const override = settings.agentOverrides?.[name]?.permission;
    if (groups.length === 0 && override === undefined) {
      continue;
    }
    const pointer = `/agent/${escapePointer(name)}/permission`;
    const layers = [...global, ...groups];
    if (agent.permission !== undefined) {
      layers.push({
        policy: nativePermission(agent.permission),
        pointer,
        shorthand: typeof agent.permission === 'string',
      });
    }
    if (override !== undefined) {
      layers.push({
        policy: override,
        pointer: `/agent/overrides/${escapePointer(name)}/permission`,
        sourceId: source.id,
      });
    }
    applyPermissionOrigins(provenance, pointer, layers);
  }
}

/** Normalize the single-file baseline without applying it or reading prompt includes. */
export function resolveLegacy(source: SourceDocument, native: NativeInput): ResolvedComposition {
  const settings = readSettings(source.value);
  settings.promptSources = Object.fromEntries(
    Object.entries(settings.promptSources).map(([alias, path]) => [
      alias,
      configurationPath(path, dirname(source.path)),
    ]),
  );
  const provenance: Record<string, FieldOrigin> = {};
  fields(native, '', provenance);
  // Map normalized settings separately from native agents (an agent can be named
  // 'groups'); origin.pointer always addresses the original source document.
  for (const [key, pointer] of [
    ['permission', '/agent/permission'],
    ['agentOverrides', '/agent/overrides'],
    ['groups', '/agent/groups'],
    ['modelPresets', '/agent/modelPresets'],
    ['promptSources', '/sourceDirectories'],
    ['promptDefaults', '/agent/prompts/defaults'],
    ['agentPrompts', '/agent/prompts/overrides'],
  ] as const) {
    const value = pointer
      .slice(1)
      .split('/')
      .reduce<unknown>((parent, segment) => (record(parent) ? parent[segment] : undefined), source.value);
    fields(value, pointer, provenance, source.id, `/settings/${key}`);
  }
  for (const [name, agent] of Object.entries(native.agent ?? {})) {
    if (agent.disable === true) {
      continue;
    }
    const pointer = `/agent/${escapePointer(name)}`;
    modelOrigins(agent, pointer, settings, source, native, provenance);
    promptOrigins(name, agent, pointer, settings, source, provenance);
  }
  effectivePermissionOrigins(source, native, settings, provenance);
  return {
    settings,
    ...(native.model === undefined ? {} : { model: native.model }),
    ...(native.small_model === undefined ? {} : { small_model: native.small_model }),
    ...(native.default_agent === undefined ? {} : { default_agent: native.default_agent }),
    sources: [structuredClone(source)],
    provenance,
    // Preserve object/array order: group and permission order can be meaningful.
    revision: createHash('sha256')
      .update(
        JSON.stringify([
          ['native', native],
          ['legacy', source.id, source.path, source.fingerprint, source.text, source.value],
        ]),
      )
      .digest('hex'),
  };
}
