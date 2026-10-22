import { SettingsError, record } from '../settings.ts';
import type { CompositionDocument } from './document-types.ts';
export const pointer = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
export const agentFields = ['model', 'variant', 'temperature', 'top_p', 'options', 'mode', 'permission'] as const;
export const commandFields = ['agent', 'model', 'subtask'] as const;
function fail(path: string, message: string): never {
  throw new SettingsError(`${path === '' ? '/' : path}: ${message}`);
}
function object(value: unknown, keys: readonly string[], path: string): asserts value is Record<string, unknown> {
  if (!record(value)) {
    fail(path, 'Expected an object.');
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail(`${path}/${pointer(key)}`, 'Unknown key.');
    }
  }
}
function name(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    fail(path, 'Expected a nonempty name.');
  }
}
function model(value: unknown, path: string) {
  if (typeof value !== 'string' || !/^[^\s/]+\/\S+$/.test(value)) {
    fail(path, 'Expected provider/model.');
  }
}
function permission(value: unknown, path: string): void {
  const action = (v: unknown) => typeof v === 'string' && ['allow', 'ask', 'deny'].includes(v);
  if (action(value)) {
    return;
  }
  if (!record(value)) {
    fail(path, 'Expected permission action or object.');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (action(entry)) {
      continue;
    }
    if (['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop'].includes(key)) {
      fail(`${path}/${pointer(key)}`, 'Expected a permission action.');
    }
    if (!record(entry) || !Object.values(entry).every(action)) {
      fail(`${path}/${pointer(key)}`, 'Expected an action or pattern block.');
    }
  }
}
function patch(value: unknown, kind: 'agent' | 'command', path: string) {
  object(value, kind === 'agent' ? agentFields : commandFields, path);
  for (const [key, v] of Object.entries(value)) {
    const at = `${path}/${pointer(key)}`;
    if (key === 'model') {
      model(v, at);
    } else if (key === 'variant') {
      if (typeof v !== 'string') {
        fail(at, 'Expected a variant string.');
      }
    } else if (key === 'agent') {
      name(v, at);
    } else if (key === 'subtask') {
      if (typeof v !== 'boolean') {
        fail(at, 'Expected a boolean.');
      }
    } else if (key === 'mode') {
      if (typeof v !== 'string' || !['primary', 'subagent', 'all'].includes(v)) {
        fail(at, 'Expected primary, subagent or all.');
      }
    } else if (key === 'temperature' || key === 'top_p') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        fail(at, 'Invalid numeric value.');
      }
    } else if (key === 'options') {
      if (!record(v)) {
        fail(at, 'Expected an options object.');
      }
      if (Object.hasOwn(v, 'groups')) {
        fail(`${at}/groups`, 'Group membership belongs on the native agent, not in options.');
      }
    } else {
      permission(v, at);
    }
  }
}
function named(value: unknown, kind: 'agent' | 'command', path: string) {
  if (!record(value)) {
    fail(path, 'Expected a named patch map.');
  }
  for (const [key, v] of Object.entries(value)) {
    name(key, path);
    patch(v, kind, `${path}/${pointer(key)}`);
  }
}
function jsonValue(value: unknown, path: string, parents = new Set<unknown>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return;
  }
  const prototype: unknown = record(value) ? Object.getPrototypeOf(value) : undefined;
  if (
    (!Array.isArray(value) && (!record(value) || (prototype !== Object.prototype && prototype !== null))) ||
    parents.has(value)
  ) {
    fail(path, 'Expected finite JSON values without cycles.');
  }
  const ancestors = new Set([...parents, value]);
  for (const [key, item] of Object.entries(value)) {
    jsonValue(item, `${path}/${pointer(key)}`, ancestors);
  }
}
export function readCompositionDocument(value: unknown): CompositionDocument {
  jsonValue(value, '');
  object(value, ['$schema', 'defaultProfile', 'model', 'small_model', 'groups', 'agent', 'command', 'profiles'], '');
  if (Object.hasOwn(value, '$schema') && typeof value.$schema !== 'string') {
    fail('/$schema', 'Expected a string.');
  }
  for (const field of ['model', 'small_model'] as const) {
    if (Object.hasOwn(value, field)) {
      model(value[field], `/${field}`);
    }
  }
  for (const kind of ['agent', 'command'] as const) {
    if (Object.hasOwn(value, kind)) {
      named(value[kind], kind, `/${kind}`);
    }
  }
  const groups = Object.hasOwn(value, 'groups') ? value.groups : [];
  if (!Array.isArray(groups)) {
    fail('/groups', 'Expected an ordered array.');
  }
  const names = new Set<string>();
  groups.forEach((group: unknown, index: number) => {
    const at = `/groups/${index}`;
    object(group, ['name', 'description', 'agent'], at);
    name(group.name, at + '/name');
    if (names.has(group.name)) {
      fail(at, 'Duplicate group identity.');
    }
    names.add(group.name);
    if (Object.hasOwn(group, 'description') && typeof group.description !== 'string') {
      fail(at, 'Expected description string.');
    }
    if (Object.hasOwn(group, 'agent')) {
      patch(group.agent, 'agent', `${at}/agent`);
    }
  });
  const profiles = Object.hasOwn(value, 'profiles') ? value.profiles : {};
  if (!record(profiles)) {
    fail('/profiles', 'Expected a profile map.');
  }
  for (const [key, profile] of Object.entries(profiles)) {
    const at = `/profiles/${pointer(key)}`;
    name(key, at);
    object(profile, ['description', 'model', 'small_model', 'groups', 'agent', 'command'], at);
    if (Object.hasOwn(profile, 'description') && typeof profile.description !== 'string') {
      fail(at, 'Expected description string.');
    }
    for (const f of ['model', 'small_model'] as const) {
      if (Object.hasOwn(profile, f)) {
        model(profile[f], `${at}/${f}`);
      }
    }
    for (const k of ['agent', 'command'] as const) {
      if (Object.hasOwn(profile, k)) {
        named(profile[k], k, `${at}/${k}`);
      }
    }
    if (Object.hasOwn(profile, 'groups')) {
      if (!Array.isArray(profile.groups)) {
        fail(at, 'Expected ordered group references.');
      }
      const seen = new Set<string>();
      profile.groups.forEach((group: unknown, index: number) => {
        const path = `${at}/groups/${index}`;
        object(group, ['name', 'agent'], path);
        name(group.name, path);
        if (!names.has(group.name)) {
          fail(path, 'Unknown group.');
        }
        if (seen.has(group.name)) {
          fail(path, 'Duplicate group reference.');
        }
        seen.add(group.name);
        if (Object.hasOwn(group, 'agent')) {
          patch(group.agent, 'agent', `${path}/agent`);
        }
      });
    }
  }
  if (Object.hasOwn(value, 'defaultProfile')) {
    name(value.defaultProfile, '/defaultProfile');
    if (!Object.hasOwn(profiles, value.defaultProfile)) {
      fail('/defaultProfile', 'Unknown profile.');
    }
  }
  // Every root, group, profile, patch, value and reference was validated above.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- This is the strict document parser boundary.
  return structuredClone({ ...value, groups, profiles }) as unknown as CompositionDocument;
}
