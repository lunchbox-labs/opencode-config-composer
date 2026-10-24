import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { mergePermission, resolveComposition } from '../src/config-composer/composition/runtime.ts';

test('permissions retain distinct patterns and append exact replacements inside moved tool blocks', () => {
  const previous = { task: { '*': 'deny', alpha: 'allow' }, edit: 'deny' };
  const merged = mergePermission(previous, { task: { beta: 'allow', '*': 'ask' } }) as Record<string, unknown>;
  assert.deepEqual(merged, { edit: 'deny', task: { alpha: 'allow', beta: 'allow', '*': 'ask' } });
  assert.deepEqual(Object.keys(merged), ['edit', 'task']);
  assert.deepEqual(Object.keys(merged.task as object), ['alpha', 'beta', '*']);
  assert.deepEqual(previous, { task: { '*': 'deny', alpha: 'allow' }, edit: 'deny' });
});

test('later touched tool blocks carry retained rules past wildcard tool rules', () => {
  const first = mergePermission(undefined, { task: { alpha: 'allow' } });
  const second = mergePermission(first, { '*': 'deny' });
  const third = mergePermission(second, { task: { beta: 'allow' } }) as Record<string, unknown>;
  assert.deepEqual(Object.entries(third), [
    ['*', 'deny'],
    ['task', { alpha: 'allow', beta: 'allow' }],
  ]);
});

test('scalar policies normalize wildcard rules without dropping distinct inherited patterns', () => {
  assert.deepEqual(mergePermission({ task: { alpha: 'allow' } }, 'deny'), { task: { alpha: 'allow' }, '*': 'deny' });
  assert.deepEqual(mergePermission({ task: { alpha: 'allow' } }, { task: 'deny' }), {
    task: { alpha: 'allow', '*': 'deny' },
  });
  assert.deepEqual(mergePermission({ task: 'deny' }, { task: { beta: 'allow' } }), {
    task: { '*': 'deny', beta: 'allow' },
  });
  assert.deepEqual(mergePermission({ question: 'deny' }, { question: 'allow' }), { question: 'allow' });
  assert.deepEqual(mergePermission({ task: 'deny' }, {}), { task: 'deny' });
});

test('profile general permission uses the native permission schema including inactive definitions', async () => {
  const schema = JSON.parse(await readFile(new URL('../schema.json', import.meta.url), 'utf8')) as object;
  const validate = new Ajv({ strict: false }).compile(schema);
  for (const permission of ['deny', {}, { '*': 'ask', task: { alpha: 'allow' }, question: 'deny' }]) {
    const value = { profiles: { quiet: { permission } } };
    assert.doesNotThrow(() => readCompositionDocument(value));
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  for (const permission of [null, [], 'invalid', { question: { '*': 'allow' } }, { task: { alpha: 'invalid' } }]) {
    const value = { profiles: { inactive: { permission } } };
    assert.throws(() => readCompositionDocument(value));
    assert.equal(validate(value), false);
  }
});

test('profile defaults follow native fallback and precede group pairs, named settings and frontmatter', () => {
  const source = { path: '/worker.md', canonicalPath: '/worker.md', fingerprint: 'x' };
  const document = readCompositionDocument({
    groups: {
      first: { agent: { permission: { task: { first: 'allow', winner: 'allow' } } } },
      second: { agent: { permission: { task: { second: 'allow', winner: 'deny' } } } },
    },
    agent: { worker: { permission: { task: { named: 'allow', winner: 'allow' } } } },
    profiles: {
      selected: {
        permission: { task: { general: 'allow', winner: 'deny' }, edit: 'deny' },
        groups: { first: { agent: { permission: { task: { profileFirst: 'allow', winner: 'ask' } } } } },
        agent: { worker: { permission: { task: { profileNamed: 'allow', winner: 'ask' } } } },
      },
    },
  });
  const result = resolveComposition(
    document,
    'selected',
    {
      permission: { task: { '*': 'deny', global: 'allow', winner: 'allow' }, read: 'allow' },
      agent: {
        worker: { groups: ['first', 'second'], permission: { task: { native: 'allow', winner: 'allow' } } },
        untouched: {},
      },
    },
    {
      worker: {
        sources: [source],
        fields: { permission: { value: { task: { pin: 'allow', winner: 'deny' } }, authored: {}, source } },
      },
    },
  );
  const task = (result.agent.worker.permission as Record<string, unknown>).task;
  assert.deepEqual(task, {
    '*': 'deny',
    global: 'allow',
    native: 'allow',
    general: 'allow',
    first: 'allow',
    profileFirst: 'allow',
    second: 'allow',
    named: 'allow',
    profileNamed: 'allow',
    pin: 'allow',
    winner: 'deny',
  });
  assert.deepEqual(Object.keys(task as object), [
    '*',
    'global',
    'native',
    'general',
    'first',
    'profileFirst',
    'second',
    'named',
    'profileNamed',
    'pin',
    'winner',
  ]);
  assert.deepEqual(result.agent.untouched.permission, {
    read: 'allow',
    task: { '*': 'deny', global: 'allow', general: 'allow', winner: 'deny' },
    edit: 'deny',
  });
  assert.deepEqual(result.agent.build.permission, result.agent.untouched.permission);
  assert.equal(result.decisions['/agent/build/permission'].origin.pointer, '/profiles/selected/permission');
  assert.deepEqual(result.permission, { task: { '*': 'deny', global: 'allow', winner: 'allow' }, read: 'allow' });
});

test('profile permission recomposes A B A Shared only without mutating the native baseline', () => {
  const native = { permission: { '*': 'ask' }, agent: { worker: { permission: { task: { alpha: 'allow' } } } } };
  const before = structuredClone(native);
  const document = readCompositionDocument({
    profiles: { a: { permission: { task: { beta: 'allow' } } }, b: { permission: 'deny' } },
  });
  const a = resolveComposition(document, 'a', native, {});
  const b = resolveComposition(document, 'b', native, {});
  assert.deepEqual((a.agent.worker.permission as Record<string, unknown>).task, { alpha: 'allow', beta: 'allow' });
  assert.deepEqual(Object.keys(b.agent.worker.permission as object), ['task', '*']);
  assert.deepEqual(resolveComposition(document, 'a', native, {}), a);
  const none = resolveComposition(document, null, native, {});
  assert.deepEqual(none.agent.worker.permission, native.agent.worker.permission);
  assert.equal(none.agent.build, undefined);
  assert.deepEqual(native, before);
});
