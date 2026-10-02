import { homedir } from 'node:os';
import { SettingsError, record } from '../settings.ts';

export type PermissionAction = 'allow' | 'ask' | 'deny';
export type PermissionPolicy = Record<string, PermissionAction | Record<string, PermissionAction>>;

function action(value: unknown): value is PermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

function key(value: string): void {
  if (/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new SettingsError('Integer-like permission and pattern keys cannot preserve authored rule order.');
  }
  if (['__proto__', 'constructor', 'prototype'].includes(value)) {
    throw new SettingsError('Unsafe permission or pattern key.');
  }
}

export function parsePermission(value: unknown): PermissionPolicy {
  if (!record(value)) {
    throw new SettingsError('Permissions must be an ordered object of allow, ask, deny, or pattern maps.');
  }
  return Object.fromEntries(
    Object.entries(value).map(([permission, rules]): [string, PermissionPolicy[string]] => {
      key(permission);
      if (action(rules)) {
        return [permission, rules];
      }
      if (['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop'].includes(permission)) {
        throw new SettingsError(`OpenCode 1.18.34 permission ${permission} requires a scalar allow, ask, or deny.`);
      }
      if (!record(rules)) {
        throw new SettingsError('Permission rules must be allow, ask, deny, or a pattern map.');
      }
      return [
        permission,
        Object.fromEntries(
          Object.entries(rules).map(([pattern, rule]) => {
            key(pattern);
            if (!action(rule)) {
              throw new SettingsError('Permission actions must be allow, ask, or deny.');
            }
            return [pattern, rule];
          }),
        ),
      ];
    }),
  );
}

/** Native config also accepts a shorthand action for all permissions. */
export function nativePermission(value: unknown): PermissionPolicy {
  if (value === undefined) {
    return {};
  }
  return parsePermission(action(value) ? { '*': value } : value);
}

export function composePermissions(layers: readonly PermissionPolicy[]): PermissionPolicy {
  const result = new Map<string, PermissionPolicy[string]>();
  for (const layer of layers) {
    for (const [permission, rules] of Object.entries(parsePermission(layer))) {
      const previous = result.get(permission);
      let next = rules;
      if (record(previous) && record(rules)) {
        const merged = new Map(Object.entries(previous));
        for (const [pattern, rule] of Object.entries(rules)) {
          merged.delete(pattern);
          merged.set(pattern, rule);
        }
        next = Object.fromEntries(merged);
      }
      result.delete(permission);
      result.set(permission, next);
    }
  }
  return Object.fromEntries(result);
}

// Matches OpenCode 1.18.34's core wildcard evaluator, including bare commands.
function matches(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) {
    escaped = escaped.slice(0, -3) + '( .*)?';
  }
  return new RegExp('^' + escaped + '$', process.platform === 'win32' ? 'si' : 's').test(input.replaceAll('\\', '/'));
}

function expand(pattern: string): string {
  if (pattern === '~' || pattern.startsWith('~/')) {
    return homedir() + pattern.slice(1);
  }
  if (pattern.startsWith('$HOME')) {
    return homedir() + pattern.slice(5);
  }
  return pattern;
}

/** Configured policy only: host-generated rules and remembered approvals are outside this explanation. */
export function explainPermission(
  policy: PermissionPolicy,
  permission: string,
  pattern: string,
): {
  action: PermissionAction;
  matched?: { permission: string; pattern: string };
} {
  let result: ReturnType<typeof explainPermission> = { action: 'ask' };
  for (const [name, value] of Object.entries(parsePermission(policy))) {
    if (!matches(permission, name)) {
      continue;
    }
    for (const [target, rule] of Object.entries(typeof value === 'string' ? { '*': value } : value)) {
      if (matches(pattern, expand(target))) {
        result = { action: rule, matched: { permission: name, pattern: target } };
      }
    }
  }
  return result;
}
