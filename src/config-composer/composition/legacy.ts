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
import {
  PermissionCompilationError,
  type PermissionPolicy,
  type PermissionRule,
  compilePermissions,
  nativePermission,
} from './permissions.ts';
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
  const { blocks, rules: authored } = compilePermissions(layers.map((layer) => layer.policy));
  const result = new Map<string, FieldOrigin>();
  const ruleOrigin = (rule: PermissionRule, block = false): FieldOrigin => {
    const layer = layers[rule.layer];
    const pointer = layer.shorthand === true ? layer.pointer : `${layer.pointer}/${escapePointer(rule.permission)}`;
    return origin(block || rule.scalar ? pointer : `${pointer}/${escapePointer(rule.pattern)}`, layer.sourceId);
  };
  let root: FieldOrigin | undefined;
  for (const layer of layers) {
    root = {
      ...origin(layer.pointer, layer.sourceId),
      ...(root === undefined ? {} : { operation: 'merge' as const }),
      overwritten: root === undefined ? [] : [root],
    };
  }
  if (root !== undefined) {
    result.set('', root);
  }
  for (const block of blocks) {
    const pointer = `/${escapePointer(block.permission)}`;
    let candidate: FieldOrigin | undefined;
    let previousRule: PermissionRule | undefined;
    for (const rule of block.rules) {
      if (previousRule?.layer !== rule.layer || previousRule.permission !== rule.permission) {
        candidate = {
          ...ruleOrigin(rule, true),
          ...(candidate === undefined || block.scalar ? {} : { operation: 'merge' as const }),
          overwritten: candidate === undefined ? [] : [candidate],
        };
      }
      previousRule = rule;
    }
    if (candidate === undefined) {
      continue;
    }
    const next = { ...candidate, references: block.effective.map((rule) => ruleOrigin(rule).pointer) };
    result.set(pointer, next);
    root?.references.push(next.pointer);
    if (block.scalar) {
      continue;
    }
    for (const effective of block.effective) {
      let winner: FieldOrigin | undefined;
      const candidates = authored
        .slice(0, authored.indexOf(effective) + 1)
        .filter(
          (rule) =>
            rule.pattern === effective.pattern &&
            (block.rules.includes(rule) || rule.permission === effective.permission),
        );
      for (const rule of candidates) {
        winner = { ...ruleOrigin(rule), overwritten: winner === undefined ? [] : [winner] };
      }
      if (winner !== undefined) {
        result.set(`${pointer}/${escapePointer(effective.pattern)}`, winner);
      }
    }
  }
  return result;
}

function applyPermissionOrigins(
  provenance: Record<string, FieldOrigin>,
  pointer: string,
  layers: PermissionLayer[],
): void {
  const origins = permissionOrigins(layers);
  for (const key of Object.keys(provenance)) {
    if (key === pointer || key.startsWith(`${pointer}/`)) {
      Reflect.deleteProperty(provenance, key);
    }
  }
  for (const [suffix, value] of origins) {
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
    try {
      applyPermissionOrigins(provenance, '/permission', global);
    } catch (error) {
      if (!(error instanceof PermissionCompilationError)) {
        throw error;
      }
      global.pop();
    }
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
    const layers = [...global];
    if (agent.permission !== undefined) {
      layers.push({
        policy: nativePermission(agent.permission),
        pointer,
        shorthand: typeof agent.permission === 'string',
      });
    }
    layers.push(...groups);
    if (override !== undefined) {
      layers.push({
        policy: override,
        pointer: `/agent/overrides/${escapePointer(name)}/permission`,
        sourceId: source.id,
      });
    }
    try {
      applyPermissionOrigins(provenance, pointer, layers);
    } catch (error) {
      if (!(error instanceof PermissionCompilationError)) {
        throw error;
      }
      // Runtime retains native agent permissions and inherits the applied global policy.
    }
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
