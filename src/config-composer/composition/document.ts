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
interface ModelReference {
  alias: string;
  path: string;
}
function models(value: unknown, path: string, aliases: Set<string>): void {
  if (!record(value)) {
    fail(path, 'Expected a model binding map.');
  }
  for (const [key, binding] of Object.entries(value)) {
    const at = `${path}/${pointer(key)}`;
    name(key, at);
    object(binding, ['model', 'variant', 'temperature', 'top_p', 'topK', 'maxOutputTokens', 'options'], at);
    model(binding.model, `${at}/model`);
    if (Object.hasOwn(binding, 'variant') && typeof binding.variant !== 'string') {
      fail(`${at}/variant`, 'Expected a variant string.');
    }
    for (const field of ['temperature', 'top_p', 'topK', 'maxOutputTokens'] as const) {
      if (!Object.hasOwn(binding, field)) {
        continue;
      }
      const number = binding[field];
      const valid =
        typeof number === 'number' &&
        Number.isFinite(number) &&
        (field === 'temperature' || field === 'top_p'
          ? number >= 0 && number <= (field === 'temperature' ? 2 : 1)
          : Number.isSafeInteger(number) && number > 0);
      if (!valid) {
        fail(
          `${at}/${field}`,
          field === 'temperature' || field === 'top_p'
            ? `Expected a number from 0 to ${field === 'temperature' ? 2 : 1}.`
            : 'Expected a positive safe integer.',
        );
      }
    }
    if (Object.hasOwn(binding, 'options')) {
      if (!record(binding.options)) {
        fail(`${at}/options`, 'Expected an options object.');
      }
      if (Object.hasOwn(binding.options, 'groups')) {
        fail(`${at}/options/groups`, 'Group membership belongs on the native agent, not in options.');
      }
      // Raw adapter controls can override protected native sampling fields on the wire.
      for (const key of [
        'temperature',
        'top_p',
        'topP',
        'topK',
        'top_k',
        'maxOutputTokens',
        'max_tokens',
        'max_completion_tokens',
      ]) {
        if (Object.hasOwn(binding.options, key)) {
          fail(`${at}/options/${key}`, 'Use the binding sampling/output fields instead of raw provider controls.');
        }
      }
    }
    aliases.add(key);
  }
}
function patch(value: unknown, kind: 'agent' | 'command', path: string, references: ModelReference[]) {
  object(value, kind === 'agent' ? [...agentFields, 'modelRef'] : commandFields, path);
  if (Object.hasOwn(value, 'model') && Object.hasOwn(value, 'modelRef')) {
    fail(`${path}/modelRef`, 'model and modelRef are mutually exclusive.');
  }
  for (const [key, v] of Object.entries(value)) {
    const at = `${path}/${pointer(key)}`;
    if (key === 'model') {
      model(v, at);
    } else if (key === 'variant') {
      if (typeof v !== 'string') {
        fail(at, 'Expected a variant string.');
      }
    } else if (key === 'modelRef') {
      name(v, at);
      references.push({ alias: v, path: at });
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
function named(value: unknown, kind: 'agent' | 'command', path: string, references: ModelReference[]) {
  if (!record(value)) {
    fail(path, 'Expected a named patch map.');
  }
  for (const [key, v] of Object.entries(value)) {
    name(key, path);
    patch(v, kind, `${path}/${pointer(key)}`, references);
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
  object(
    value,
    ['$schema', 'defaultProfile', 'model', 'small_model', 'models', 'groups', 'agent', 'command', 'profiles'],
    '',
  );
  const aliases = new Set<string>();
  const references: ModelReference[] = [];
  if (Object.hasOwn(value, 'models')) {
    models(value.models, '/models', aliases);
  }
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
      named(value[kind], kind, `/${kind}`, references);
    }
  }
  const groups = Object.hasOwn(value, 'groups') ? value.groups : {};
  if (!record(groups)) {
    fail('/groups', 'Expected a group map.');
  }
  for (const [key, group] of Object.entries(groups)) {
    const at = `/groups/${pointer(key)}`;
    name(key, at);
    object(group, ['description', 'agent'], at);
    if (Object.hasOwn(group, 'description') && typeof group.description !== 'string') {
      fail(at, 'Expected description string.');
    }
    if (Object.hasOwn(group, 'agent')) {
      patch(group.agent, 'agent', `${at}/agent`, references);
    }
  }
  const profiles = Object.hasOwn(value, 'profiles') ? value.profiles : {};
  if (!record(profiles)) {
    fail('/profiles', 'Expected a profile map.');
  }
  for (const [key, profile] of Object.entries(profiles)) {
    const at = `/profiles/${pointer(key)}`;
    name(key, at);
    object(profile, ['description', 'permission', 'model', 'small_model', 'models', 'groups', 'agent', 'command'], at);
    if (Object.hasOwn(profile, 'permission')) {
      permission(profile.permission, `${at}/permission`);
    }
    if (Object.hasOwn(profile, 'models')) {
      models(profile.models, `${at}/models`, aliases);
    }
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
        named(profile[k], k, `${at}/${k}`, references);
      }
    }
    if (Object.hasOwn(profile, 'groups')) {
      if (!record(profile.groups)) {
        fail(`${at}/groups`, 'Expected a group patch map.');
      }
      for (const [key, group] of Object.entries(profile.groups)) {
        const path = `${at}/groups/${pointer(key)}`;
        name(key, path);
        object(group, ['agent'], path);
        if (!Object.hasOwn(groups, key)) {
          fail(path, 'Unknown group.');
        }
        if (Object.hasOwn(group, 'agent')) {
          patch(group.agent, 'agent', `${path}/agent`, references);
        }
      }
    }
  }
  for (const { alias, path } of references) {
    if (!aliases.has(alias)) {
      fail(path, `Unknown model alias ${JSON.stringify(alias)}.`);
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
