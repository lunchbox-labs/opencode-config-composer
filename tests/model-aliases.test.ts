import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { parseConfiguration } from '../src/config-composer/configuration.ts';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { resolveComposition } from '../src/config-composer/composition/runtime.ts';
import { fieldDetail } from '../src/config-composer/tui/view.ts';
import type { AttestedRuntime } from '../src/config-composer/composition/runtime-baseline.ts';

const native = {
  agent: { worker: { groups: ['coding'], model: 'p/native', variant: 'native', options: { kept: false } } },
};
const resolve = (value: unknown, choice: string | null = null) =>
  resolveComposition(readCompositionDocument(value), choice, native, {});

test('model alias definitions and references have parser/schema structural parity', async () => {
  const schema = JSON.parse(await readFile(new URL('../schema.json', import.meta.url), 'utf8')) as object;
  const validate = new Ajv({ strict: false }).compile(schema);
  for (const value of [
    { models: {} },
    { models: { coding: { model: 'p/root', variant: '' } }, agent: { build: { modelRef: 'coding', variant: 'high' } } },
    { models: { coding: { model: 'p/root' } }, groups: { coding: { agent: { modelRef: 'coding' } } } },
    {
      profiles: { inactive: { models: { coding: { model: 'p/profile' } }, agent: { build: { modelRef: 'coding' } } } },
    },
    {
      groups: { coding: {} },
      profiles: {
        selected: { models: { coding: { model: 'p/profile' } }, groups: { coding: { agent: { modelRef: 'coding' } } } },
      },
    },
  ]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => readCompositionDocument(value));
  }
  for (const value of [
    { models: [] },
    { models: { ' ': { model: 'p/m' } } },
    { models: { '\0': { model: 'p/m' } } },
    { models: { coding: {} } },
    { models: { coding: { model: 'invalid' } } },
    { models: { coding: { model: 'p/m', variant: null } } },
    { models: { coding: { model: 'p/m', modelRef: 'other' } } },
    { models: { coding: { model: 'p/m', options: {} } } },
    { profiles: { inactive: { models: { coding: { variant: 'high' } } } } },
    { agent: { build: { modelRef: '' } } },
    { agent: { build: { modelRef: '\0' } } },
    { agent: { build: { modelRef: 'coding', model: 'p/m' } } },
    { groups: { coding: { agent: { modelRef: 'coding', model: 'p/m' } } } },
    { profiles: { inactive: { agent: { build: { modelRef: 'coding', model: 'p/m' } } } } },
    { modelRef: 'coding' },
    { command: { run: { modelRef: 'coding' } } },
    { profiles: { inactive: { modelRef: 'coding' } } },
  ]) {
    assert.equal(validate(value), false, JSON.stringify(value));
    assert.throws(() => readCompositionDocument(value), Error, JSON.stringify(value));
  }
});

test('profile bindings replace the whole root model choice and clear stale variants', () => {
  const doc = {
    models: { coding: { model: 'p/root', variant: 'root' } },
    groups: { coding: { agent: { modelRef: 'coding' } } },
    profiles: {
      a: { models: { coding: { model: 'p/a', variant: 'high' } } },
      b: { models: { coding: { model: 'p/b' } } },
    },
  };
  for (const [choice, model, variant] of [
    ['a', 'p/a', 'high'],
    ['b', 'p/b', ''],
    ['a', 'p/a', 'high'],
    [null, 'p/root', 'root'],
  ] as const) {
    const result = resolve(doc, choice);
    assert.equal(result.agent.worker.model, model);
    assert.equal(result.agent.worker.variant, variant);
    assert.deepEqual(result.agent.worker.options, { kept: false });
    assert.equal(result.agent.worker.modelRef, undefined);
    assert.equal(result.models, undefined);
  }
  assert.equal(
    resolve({ models: { coding: { model: 'p/default' } }, groups: { coding: { agent: { modelRef: 'coding' } } } }).agent
      .worker.variant,
    '',
  );
});

test('explicit referencing variants and later patches win while literal model semantics remain independent', () => {
  const base = {
    models: { coding: { model: 'p/alias', variant: 'binding' } },
    groups: { coding: { agent: { modelRef: 'coding', variant: 'explicit' } }, later: { agent: { variant: 'later' } } },
    profiles: { selected: { groups: { coding: { agent: { modelRef: 'coding', variant: 'profile-group' } } } } },
  };
  assert.equal(resolve(base).agent.worker.variant, 'explicit');
  assert.equal(resolve(base, 'selected').agent.worker.variant, 'profile-group');
  const ordered = resolveComposition(
    readCompositionDocument(base),
    'selected',
    {
      agent: { forward: { groups: ['coding', 'later'] }, reverse: { groups: ['later', 'coding'] } },
    },
    {},
  );
  assert.equal(ordered.agent.forward.variant, 'later');
  assert.equal(ordered.agent.reverse.variant, 'profile-group');
  assert.equal(resolve({ ...base, agent: { worker: { model: 'p/literal' } } }).agent.worker.variant, 'explicit');
  assert.equal(resolve({ ...base, agent: { worker: { modelRef: 'coding', variant: '' } } }).agent.worker.variant, '');
  const named = resolve(
    {
      ...base,
      agent: { worker: { modelRef: 'coding', variant: 'root-named' } },
      profiles: { selected: { agent: { worker: { variant: 'profile-named' } } } },
    },
    'selected',
  );
  assert.equal(named.agent.worker.variant, 'profile-named');
});

test('profile-only aliases contribute neither model nor referencing variant in Shared only', () => {
  const doc = {
    groups: { coding: { agent: { modelRef: 'coding', variant: 'explicit', temperature: 0 } } },
    agent: { worker: { modelRef: 'coding', variant: 'named' } },
    profiles: { a: { models: { coding: { model: 'p/a', variant: 'binding' } } }, b: {} },
  };
  const shared = resolve(doc);
  assert.equal(shared.agent.worker.model, 'p/native');
  assert.equal(shared.agent.worker.variant, 'native');
  assert.equal(shared.agent.worker.temperature, 0);
  assert.equal(resolve(doc, 'a').agent.worker.variant, 'named');
  assert.throws(() => resolve(doc, 'b'), /\/groups\/coding\/agent\/modelRef.*coding.*profile.*b/i);
});

test('unknown aliases fail even in unused groups and inactive profiles with escaped pointer context', () => {
  for (const [value, path] of [
    [{ groups: { unused: { agent: { modelRef: 'missing' } } } }, '/groups/unused/agent/modelRef'],
    [
      { profiles: { inactive: { agent: { build: { modelRef: 'missing' } } } } },
      '/profiles/inactive/agent/build/modelRef',
    ],
    [
      { groups: { 'a/b~c': {} }, profiles: { 'p/q': { groups: { 'a/b~c': { agent: { modelRef: 'missing' } } } } } },
      '/profiles/p~1q/groups/a~1b~0c/agent/modelRef',
    ],
    [{ agent: { build: { modelRef: 'constructor' } } }, '/agent/build/modelRef'],
  ] as const) {
    assert.throws(
      () => readCompositionDocument(value),
      (error: unknown) =>
        error instanceof Error && error.message.includes(path) && error.message.includes('Unknown model alias'),
    );
  }
  assert.throws(
    () => readCompositionDocument({ profiles: { inactive: { models: { coding: { model: 'bad' } } } } }),
    /\/profiles\/inactive\/models\/coding\/model/,
  );
});

test('binding validation follows consumed groups even when later patches or frontmatter shadow them', () => {
  const doc = readCompositionDocument({
    groups: { unused: { agent: { modelRef: 'coding' } }, coding: { agent: { modelRef: 'coding' } } },
    agent: { worker: { model: 'p/override' } },
    profiles: { a: { models: { coding: { model: 'p/a' } } }, b: {} },
  });
  assert.doesNotThrow(() => resolveComposition(doc, 'b', { agent: { worker: {} } }, {}));
  const source = { path: '/worker.md', canonicalPath: '/worker.md', fingerprint: 'x' };
  assert.throws(
    () =>
      resolveComposition(doc, 'b', native, {
        worker: { fields: { model: { value: 'p/pin', authored: { model: 'p/pin' }, source } }, sources: [source] },
      }),
    /\/groups\/coding\/agent\/modelRef.*coding.*profile.*b/i,
  );
});

test('exact prototype-like alias keys resolve safely and preserve binding and reference provenance', () => {
  const doc = readCompositionDocument(
    parseConfiguration(
      '{"models":{"__proto__":{"model":"p/proto","variant":"high"},"constructor":{"model":"p/root"}},"groups":{"coding":{"agent":{"modelRef":"__proto__"}}},"profiles":{"a/b~c":{"models":{"__proto__":{"model":"p/profile"}}}}}',
    ),
  );
  const result = resolveComposition(doc, 'a/b~c', native, {});
  assert.equal(result.agent.worker.model, 'p/profile');
  assert.equal(result.agent.worker.variant, '');
  assert.equal(result.decisions['/agent/worker/model'].origin.pointer, '/groups/coding/agent/modelRef');
  const runtime = { observation: { authority: {} } } as unknown as AttestedRuntime;
  const context = { runtime, source: { path: '/composer.jsonc' } };
  const model = fieldDetail({ context }, '/agent/worker/model', result.decisions['/agent/worker/model']);
  assert.match(model, /__proto__/);
  assert.match(model, /\/groups\/coding\/agent\/modelRef/);
  assert.match(model, /\/profiles\/a~1b~0c\/models\/__proto__/);
  assert.match(
    fieldDetail({ context }, '/agent/worker/variant', result.decisions['/agent/worker/variant']),
    /native default/i,
  );
});

test('final authored model and intentional variant pins retain blocked alias provenance', () => {
  const doc = readCompositionDocument({
    models: { coding: { model: 'p/alias' } },
    groups: { coding: { agent: { modelRef: 'coding' } } },
  });
  const source = { path: '/agents/worker.md', canonicalPath: '/agents/worker.md', fingerprint: 'x' };
  const authority = {
    worker: {
      fields: {
        model: { value: 'p/pin', authored: { model: 'p/pin' }, source },
        variant: { value: 'intentional', authored: { variant: 'intentional' }, source },
      },
      sources: [source],
    },
  };
  const result = resolveComposition(doc, null, native, authority);
  assert.equal(result.agent.worker.model, 'p/pin');
  assert.equal(result.agent.worker.variant, 'intentional');
  const runtime = { observation: { authority } } as unknown as AttestedRuntime;
  const text = fieldDetail(
    { context: { runtime, source: { path: '/composer.jsonc' } } },
    '/agent/worker/model',
    result.decisions['/agent/worker/model'],
  );
  assert.match(text, /Pinned by frontmatter/);
  assert.match(text, /Blocked Composer value: "p\/alias"/);
  assert.match(text, /\/models\/coding/);
});
