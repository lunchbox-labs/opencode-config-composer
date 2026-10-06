import { type FilePlan, type Snapshot, editJson } from '../storage.ts';
import { SettingsError, record } from '../settings.ts';
import { definitionDestinations } from './authoring.ts';
import { type ConfigurationTarget, configurationTargets, valueAt } from './parameter-authoring.ts';
import { parseCompositionDocument, readCompositionDocument } from './document.ts';
import type { ConfiguredPermissionPreview, PermissionRule } from './types.ts';
import type { PermissionContribution } from './runtime.ts';

export const permissionStatus =
  'Configured preview only. Native permission compilation and failure handling are not integrated; this draft cannot apply selected permission contributions.';

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
  const selected = configurationTargets(snapshot, target.sourceId).find(
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

// OpenCode 1.18.34 wildcard semantics, with bounded work instead of an unbounded backtracking regex.
function matches(value: string, pattern: string, budget: { remaining: number }): boolean {
  value = value.replaceAll('\\', '/');
  pattern = pattern.replaceAll('\\', '/');
  const literal = new Map<string, RegExp>();
  const match = (pattern: string): boolean => {
    let input = 0;
    let rule = 0;
    let star = -1;
    let retry = 0;
    while (input < value.length) {
      if (--budget.remaining < 0) {
        throw new SettingsError(
          'Permission preview exceeds the matching work limit. Shorten the test input or simplify the wildcard patterns.',
        );
      }
      const token = pattern.at(rule);
      let equal = token === value[input];
      if (!equal && token !== undefined && token !== '*' && token !== '?' && process.platform === 'win32') {
        let expression = literal.get(token);
        if (expression === undefined) {
          expression = new RegExp(`^${token.replace(/[.+^${}()|[\]\\]/g, '\\$&')}$`, 'i');
          literal.set(token, expression);
        }
        equal = expression.test(value[input]);
      }
      if (token === '*') {
        star = rule++;
        retry = input;
      } else if (token === '?' || equal) {
        input++;
        rule++;
      } else if (star >= 0) {
        rule = star + 1;
        input = ++retry;
      } else {
        return false;
      }
    }
    while (pattern[rule] === '*') {
      rule++;
    }
    return rule === pattern.length;
  };
  return match(pattern) || (pattern.endsWith(' *') && match(pattern.slice(0, -2)));
}

/** Evaluate only ordered authored contributions; no match defers without inventing a native action. */
export function previewPermission(
  contributions: readonly PermissionContribution[],
  agent: string,
  tool: string,
  input: string,
): ConfiguredPermissionPreview {
  const budget = { remaining: 1_000_000 };
  const matching = contributions.filter(
    (item) =>
      item.agent === agent && matches(tool, item.rule.tool, budget) && matches(input, item.rule.pattern ?? '*', budget),
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
