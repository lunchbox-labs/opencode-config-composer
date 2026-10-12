import { createHash } from 'node:crypto';
import {
  type AgentSettings,
  type GroupChoice,
  type GroupOptions,
  agentGroups,
  readSettings,
  record,
  resolveChoice,
  resolveGroup,
} from '../settings.ts';
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

/** Normalize the single-file baseline without applying it. */
export function resolveLegacy(source: SourceDocument, native: NativeInput): ResolvedComposition {
  const settings = readSettings(source.value);
  const provenance: Record<string, FieldOrigin> = {};
  fields(native, '', provenance);
  // Map normalized settings separately from native agents (an agent can be named
  // 'groups'); origin.pointer always addresses the original source document.
  for (const [key, pointer] of [
    ['groups', '/agent/groups'],
    ['modelPresets', '/agent/modelPresets'],
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
  }
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
