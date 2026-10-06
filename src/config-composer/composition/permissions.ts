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

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
  layer: number;
  scalar: boolean;
}

export interface PermissionBlock {
  permission: string;
  rules: PermissionRule[];
  effective: PermissionRule[];
  scalar: boolean;
}

const scalarPermissions = ['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop'];

function compact(permission: string, rules: PermissionRule[]): PermissionBlock {
  const effective = new Map<string, PermissionRule>();
  for (const rule of rules) {
    if (rule.scalar) {
      effective.clear();
    }
    effective.delete(rule.pattern);
    effective.set(rule.pattern, rule);
  }
  const last = rules.at(-1);
  const scalar = last?.scalar === true;
  return { permission, rules, effective: [...effective.values()], scalar };
}

// Whether two native permission-name globs can match the same name. This is
// an emptiness check, not a specificity ordering. Each transition advances a
// pattern position; '*'/'*' self-loops need not consume for an existence test.
function overlaps(left: string, right: string): boolean {
  const variants = (pattern: string) => (pattern.endsWith(' *') ? [pattern, pattern.slice(0, -2)] : [pattern]);
  return variants(left.replaceAll('\\', '/')).some((a) =>
    variants(right.replaceAll('\\', '/')).some((b) => {
      const cache = new Map<string, boolean>();
      const visit = (i: number, j: number): boolean => {
        const key = `${i}:${j}`;
        const known = cache.get(key);
        if (known !== undefined) {
          return known;
        }
        let result: boolean;
        if (i === a.length && j === b.length) {
          result = true;
        } else if (a[i] === '*') {
          result = visit(i + 1, j) || (j < b.length && visit(i, j + 1));
        } else if (b[j] === '*') {
          result = visit(i, j + 1) || (i < a.length && visit(i + 1, j));
        } else {
          result =
            i < a.length &&
            j < b.length &&
            (a[i] === '?' || b[j] === '?' || matches(a[i], b[j])) &&
            visit(i + 1, j + 1);
        }
        cache.set(key, result);
        return result;
      };
      return visit(0, 0);
    }),
  );
}

// A bounded containment proof: universal globs cover every name; otherwise
// prove a fixed-width domain against a covering glob using symbolic '?' slots.
// A literal cannot cover an arbitrary slot. Unknown cases remain unsupported.
function covers(cover: string, domain: string): boolean {
  cover = cover.replaceAll('\\', '/');
  domain = domain.replaceAll('\\', '/');
  if (/^\*+$/.test(cover)) {
    return true;
  }
  if (domain.includes('*') || cover.endsWith(' *')) {
    return false;
  }
  const cache = new Map<string, boolean>();
  const visit = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    const known = cache.get(key);
    if (known !== undefined) {
      return known;
    }
    const result =
      i === cover.length
        ? j === domain.length
        : cover[i] === '*'
          ? visit(i + 1, j) || (j < domain.length && visit(i, j + 1))
          : j < domain.length &&
            (cover[i] === '?' || (domain[j] !== '?' && matches(domain[j], cover[i]))) &&
            visit(i + 1, j + 1);
    cache.set(key, result);
    return result;
  };
  return visit(0, 0);
}

/** Lower ordered contributions without moving old matches past newer rules. */
export function compilePermissions(layers: readonly PermissionPolicy[]): {
  policy: PermissionPolicy;
  blocks: PermissionBlock[];
  rules: PermissionRule[];
} {
  const authored = layers
    .flatMap((layer, index) =>
      Object.entries(parsePermission(layer)).map(([permission, value]) => ({
        permission,
        rules: Object.entries(typeof value === 'string' ? { '*': value } : value).map(([pattern, action]) => ({
          permission,
          pattern,
          action,
          layer: index,
          scalar: typeof value === 'string',
        })),
      })),
    )
    .filter((block) => block.rules.length > 0);
  const rules = authored.flatMap((block) => block.rules);
  const exact: string[] = [];
  const ordered: { permission: string; rules: PermissionRule[] }[] = [];
  for (const block of authored) {
    if (!/[?*]/.test(block.permission) && !scalarPermissions.includes(block.permission)) {
      if (!exact.some((name) => matches(name, block.permission))) {
        exact.push(block.permission);
      }
      continue;
    }
    let blockRules = [...block.rules];
    if (scalarPermissions.includes(block.permission)) {
      const previous = ordered.findIndex((item) => item.permission === block.permission);
      if (previous !== -1) {
        blockRules = [...ordered[previous].rules, ...blockRules];
        ordered.splice(previous, 1);
      }
    }
    const previous = ordered.at(-1);
    if (previous?.permission === block.permission) {
      previous.rules.push(...blockRules);
    } else {
      ordered.push({ permission: block.permission, rules: blockRules });
    }
  }

  const reserved = new Set(authored.map((block) => block.permission));
  const emitted = new Set<string>();
  const blocks: PermissionBlock[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const block = ordered[index];
    const later = ordered.findIndex((item, position) => position > index && item.permission === block.permission);
    // A repeated '?' pattern has no distinct, equivalent native object key.
    // Coalesce across disjoint contributions or replay whole-domain ones.
    const star = block.permission
      .split('')
      .findIndex(
        (char, position) =>
          char === '*' && !(position === block.permission.length - 1 && block.permission[position - 1] === ' '),
      );
    if (later !== -1 && star === -1) {
      const replay = [...block.rules];
      for (const intervening of ordered.slice(index + 1, later)) {
        if (!overlaps(block.permission, intervening.permission)) {
          continue;
        }
        if (!covers(intervening.permission, block.permission)) {
          throw new SettingsError(
            `Unsupported permission compilation for interleaved ${block.permission} blocks across ${intervening.permission}. This compiler cannot yet preserve this ordering in native configuration. Use concrete permission names for this contribution.`,
          );
        }
        replay.push(...intervening.rules);
      }
      ordered[later].rules.unshift(...replay);
      continue;
    }
    let permission = block.permission;
    if (emitted.has(permission)) {
      // Consecutive '*' tokens are equivalent in the native matcher. Only
      // duplicate a star that is not the special optional trailing " *".
      do {
        permission = permission.slice(0, star) + '*' + permission.slice(star);
      } while (reserved.has(permission) || emitted.has(permission));
    }
    emitted.add(permission);
    blocks.push(compact(permission, block.rules));
  }
  // Exact tool blocks are evaluated last and include every wildcard rule that
  // matched that name, in original layer order. Nothing else is broadened.
  for (const permission of exact) {
    blocks.push(
      compact(
        permission,
        rules.filter((rule) => matches(permission, rule.permission)),
      ),
    );
  }
  const policy = Object.fromEntries(
    blocks.map((block) => [
      block.permission,
      block.scalar
        ? block.effective[0].action
        : Object.fromEntries(block.effective.map((rule) => [rule.pattern, rule.action])),
    ]),
  );
  return { policy, blocks, rules };
}

export function composePermissions(layers: readonly PermissionPolicy[]): PermissionPolicy {
  return compilePermissions(layers).policy;
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
  action?: PermissionAction;
  fallback?: 'native';
  matched?: { permission: string; pattern: string };
} {
  let result: ReturnType<typeof explainPermission> = { fallback: 'native' };
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
