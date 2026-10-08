import { type FilePlan, type Snapshot, editJson } from '../storage.ts';
import { matches } from './permission-matching.ts';
import { SettingsError, record } from '../settings.ts';
import { definitionDestinations } from './authoring.ts';
import { type ConfigurationTarget, configurationTargets, valueAt } from './parameter-authoring.ts';
import { parseCompositionDocument, readCompositionDocument } from './document.ts';
import type { ConfiguredPermissionPreview, PermissionRule } from './types.ts';
import type { PermissionContribution } from './runtime.ts';

export const permissionStatus =
  'Configured preview only; session approvals and native defaults may differ. Reload applies supported rules. An unsupported scope skips its Composer permissions with a visible warning and may fall back to more permissive rules.';

export function permissionTargets(snapshot: Snapshot, sourceId: string): ConfigurationTarget[] {
  const targets = configurationTargets(snapshot, sourceId);
  if (!definitionDestinations(snapshot).some((file) => file.path === sourceId)) {
    return [];
  }
  if (snapshot.sources.scopes.some((scope) => scope.id === sourceId)) {
    targets.unshift(
      { sourceId, path: ['defaults'], label: 'Global defaults' },
      { sourceId, path: ['overrides'], label: 'Global overrides' },
    );
  }
  const source = snapshot.sources.documents.find((source) => source.id === sourceId);
  for (const name of Object.keys(source?.value.profiles ?? {})) {
    targets.push({ sourceId, path: ['profiles', name, 'overrides'], label: `Profile ${name}: global overrides` });
  }
  return targets;
}

export function permissionRules(value: unknown): PermissionRule[] {
  return (
    readCompositionDocument({ configurationPresets: { validation: { permissions: value } } }).configurationPresets
      ?.validation.permissions ?? []
  );
}

export function localPermissionRules(snapshot: Snapshot, target: ConfigurationTarget): PermissionRule[] | undefined {
  const source = snapshot.sources.documents.find((source) => source.id === target.sourceId);
  const value = valueAt(source?.value, [...target.path, 'permissions']);
  return value === undefined ? undefined : permissionRules(value);
}

export function planPermissions(snapshot: Snapshot, target: ConfigurationTarget, rules: unknown): FilePlan {
  const selected = permissionTargets(snapshot, target.sourceId).find(
    (item) => JSON.stringify(item.path) === JSON.stringify(target.path),
  );
  const file = definitionDestinations(snapshot).find((file) => file.path === target.sourceId);
  if (selected === undefined || file === undefined) {
    throw new SettingsError('Choose an available writable permission destination and target.');
  }
  const value = rules === undefined ? undefined : permissionRules(rules);
  const source = snapshot.sources.documents.find((source) => source.id === target.sourceId);
  const configuration = valueAt(source?.value, target.path);
  if (
    value === undefined &&
    target.path[0] === 'configurationPresets' &&
    record(configuration) &&
    Object.keys(configuration).every((key) => key === 'permissions')
  ) {
    throw new SettingsError(
      'A preset needs at least one setting. Save an empty rule list, or delete the unused preset in the definition editor.',
    );
  }
  const text = editJson(file.text, [...target.path, 'permissions'], value);
  parseCompositionDocument(text, file.path);
  return {
    snapshot,
    edits: text === file.text ? [] : [{ file, text }],
    description: `${selected.label}: ${value === undefined ? 'remove local permission rules' : `save ${value.length} ordered permission rules`} in ${file.path}. Earlier contributions remain in effect unless a later rule matches.`,
  };
}

/** Evaluate only ordered authored contributions; no match defers without inventing a native action. */
export function previewPermission(
  contributions: readonly PermissionContribution[],
  agent: string,
  tool: string,
  input: string,
): ConfiguredPermissionPreview {
  const budget = { remaining: 1_000_000 };
  const exhausted = (): never => {
    throw new SettingsError(
      'Permission preview exceeds the matching work limit. Shorten the test input or simplify the wildcard patterns.',
    );
  };
  const matching = contributions.filter(
    (item) =>
      item.agent === agent &&
      matches(tool, item.rule.tool, budget, exhausted) &&
      matches(input, item.rule.pattern ?? '*', budget, exhausted),
  );
  const winner = matching.at(-1);
  if (winner === undefined) {
    return { fallback: 'native' };
  }
  return {
    action: winner.rule.action,
    matched: { permission: winner.rule.tool, pattern: winner.rule.pattern ?? '*' },
    origin: {
      ...winner.origin,
      overwritten: [...winner.origin.overwritten, ...matching.slice(0, -1).map((item) => item.origin)],
    },
  };
}
