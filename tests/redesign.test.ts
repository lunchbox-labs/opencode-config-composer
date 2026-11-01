import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { resolveComposition } from '../src/config-composer/composition/runtime.ts';
import { parseConfiguration } from '../src/config-composer/configuration.ts';
import { actionOnlyPermissions } from '../src/config-composer/host.ts';
const native = {
  model: 'p/native',
  agent: { worker: { prompt: 'opaque', options: {}, permission: {} } },
  command: { run: { template: 'opaque', subtask: true } },
};
const read = readCompositionDocument;
const grouped = (base: typeof native | { agent: Record<string, Record<string, unknown>> }, ...groups: string[]) => ({
  ...base,
  agent: { ...base.agent, worker: { ...base.agent.worker, groups } },
});
test('strict new document validates inactive references and preserves prototype-like exact names', () => {
  for (const value of [
    { activeProfiles: [] },
    { groups: [] },
    { groups: { a: { members: { agent: [] } } } },
    { profiles: { bad: { groups: { absent: {} } } } },
    { defaultProfile: 'constructor' },
    { agent: { worker: { groups: [] } } },
    { command: { run: { variant: 'high' } } },
    { model: null },
  ]) {
    assert.throws(() => read(value));
  }
  assert.throws(() => parseConfiguration('{"profiles":{"a":{},"a":{}}}'), /duplicate JSON/);
  const doc = read(JSON.parse('{"profiles":{"constructor":{}},"defaultProfile":"constructor","groups":{}}'));
  assert.equal(resolveComposition(doc, undefined, native, {}).profile, 'constructor');
});
test('owned groups always apply, named exceptions follow groups, none retains groups', () => {
  const doc = read({
    groups: { workers: { agent: { model: 'p/group', temperature: 0.2 } } },
    agent: { worker: { model: 'p/root' } },
    profiles: {
      a: { groups: { workers: { agent: { model: 'p/a', variant: 'high' } } } },
      b: { agent: { worker: { model: 'p/b' } } },
    },
    defaultProfile: 'a',
  });
  assert.equal(resolveComposition(doc, undefined, grouped(native, 'workers'), {}).agent.worker.model, 'p/root');
  assert.equal(resolveComposition(doc, null, grouped(native, 'workers'), {}).agent.worker.model, 'p/root');
  assert.equal(resolveComposition(doc, null, grouped(native, 'workers'), {}).agent.worker.temperature, 0.2);
  assert.equal(resolveComposition(doc, null, native, {}).command.run.subtask, true);
  assert.equal(resolveComposition(doc, 'b', grouped(native, 'workers'), {}).agent.worker.variant, undefined);
  assert.deepEqual(native.agent.worker, { prompt: 'opaque', options: {}, permission: {} });
});
test('final raw frontmatter pins block Composer including empty fields and scalar policy', () => {
  const doc = read({
    agent: {
      worker: {
        model: 'p/composer',
        variant: 'high',
        temperature: 1,
        options: { x: true },
        permission: { read: 'allow' },
      },
    },
  });
  const source = { path: '/native/worker.md', canonicalPath: '/native/worker.md', fingerprint: 'x' };
  const fields = Object.fromEntries(
    Object.entries({ model: '', variant: '', temperature: 0, options: {}, permission: 'deny' }).map(([name, value]) => [
      name,
      { value, authored: { [name]: value }, source },
    ]),
  );
  const result = resolveComposition(doc, null, native, { worker: { fields, sources: [source] } });
  assert.equal(result.agent.worker.model, '');
  assert.equal(result.agent.worker.variant, '');
  assert.equal(result.agent.worker.temperature, 0);
  assert.deepEqual(result.agent.worker.options, {});
  assert.deepEqual(result.agent.worker.permission, { read: 'allow', '*': 'deny' });
  assert.deepEqual(Object.keys(result.agent.worker.permission as object), ['read', '*']);
  assert.deepEqual(result.decisions['/agent/worker/model'].blockedComposer?.value, 'p/composer');
  assert.equal(result.decisions['/agent/worker/model'].origin.source, '/native/worker.md');
});
test('overlapping groups follow the agent array and report the winning source', () => {
  const document = read({
    groups: { first: { agent: { temperature: 0.1, model: 'p/group' } }, last: { agent: { temperature: 0.2 } } },
    profiles: {
      reversed: {
        groups: { last: { agent: { temperature: 0.3 } }, first: { agent: { temperature: 0.4 } } },
      },
    },
  });
  const baseline = { agent: { worker: { groups: ['first', 'last'], model: 'p/native' } } };
  const root = resolveComposition(document, null, baseline, {});
  assert.equal(root.agent.worker.temperature, 0.2);
  assert.equal(root.agent.worker.model, 'p/group');
  const selected = resolveComposition(document, 'reversed', baseline, {});
  assert.equal(selected.agent.worker.temperature, 0.3);
  assert.equal(
    selected.decisions['/agent/worker/temperature'].origin.pointer,
    '/profiles/reversed/groups/last/agent/temperature',
  );
});

test('each Composer contribution reports its blocked values beneath final authored fields', () => {
  const patch = {
    model: 'p/composer',
    variant: 'high',
    temperature: 1,
    top_p: 1,
    options: { flag: true },
    mode: 'subagent',
    permission: 'allow',
  };
  const values = {
    model: 'p/pinned',
    variant: '',
    temperature: 0,
    top_p: 0,
    options: { flag: false },
    mode: 'primary',
    permission: { '*': 'deny' },
  };
  const source = { path: '/native/worker.md', canonicalPath: '/native/worker.md', fingerprint: 'x' };
  const fields = Object.fromEntries(
    Object.entries(values).map(([field, value]) => [field, { value, authored: { [field]: value }, source }]),
  );
  const membership = { workers: {} };
  for (const [kind, document] of [
    ['group', { groups: { workers: { agent: patch } } }],
    ['root', { agent: { worker: patch } }],
    [
      'profile-group',
      {
        groups: membership,
        profiles: { selected: { groups: { workers: { agent: patch } } } },
        defaultProfile: 'selected',
      },
    ],
    ['profile', { profiles: { selected: { agent: { worker: patch } } }, defaultProfile: 'selected' }],
  ] as const) {
    const result = resolveComposition(
      read(document),
      undefined,
      {
        agent: {
          worker: {
            prompt: 'OPAQUE_BODY',
            groups: 'groups' in document ? Object.keys(document.groups) : [],
          },
        },
      },
      { worker: { fields, sources: [source] } },
    );
    for (const [field, value] of Object.entries(values)) {
      assert.deepEqual(result.agent.worker[field], value, `${kind}: ${field}`);
      assert.equal(result.decisions[`/agent/worker/${field}`].origin.kind, 'frontmatter');
      assert.equal(result.decisions[`/agent/worker/${field}`].blockedComposer?.origin.kind, kind);
    }
    assert.equal(result.agent.worker.prompt, 'OPAQUE_BODY');
  }
});
test('permission blocks combine patterns and move to incoming order; options are atomic', () => {
  const doc = read({
    agent: { worker: { options: { new: false }, permission: { read: { '*.md': 'ask' }, bash: 'deny' } } },
  });
  const result = resolveComposition(
    doc,
    null,
    {
      ...native,
      agent: { worker: { options: { old: true }, permission: { bash: 'allow', read: { '*': 'deny' }, edit: 'ask' } } },
    },
    {},
  );
  assert.deepEqual(Object.keys(result.agent.worker.permission as object), ['edit', 'read', 'bash']);
  assert.deepEqual(result.agent.worker.permission, { edit: 'ask', read: { '*': 'deny', '*.md': 'ask' }, bash: 'deny' });
  assert.deepEqual(result.agent.worker.options, { new: false });
});
test('unknown inactive targets, disabled command targets and no visible primary fail atomically', () => {
  for (const doc of [
    { profiles: { bad: { agent: { missing: { model: 'p/m' } } } } },
    { agent: { build: { mode: 'subagent' }, plan: { mode: 'subagent' } } },
    { command: { run: { agent: 'missing' } } },
  ]) {
    assert.throws(() =>
      resolveComposition(read(doc), null, { ...native, agent: { worker: { mode: 'subagent' } } }, {}),
    );
  }
  assert.throws(() =>
    resolveComposition(
      read({ command: { run: { agent: 'worker' } } }),
      null,
      { ...native, agent: { worker: { disable: true } } },
      {},
    ),
  );
  assert.doesNotThrow(() => resolveComposition(read({}), null, { ...native, default_agent: 'worker' }, {}));
});
test('legacy group arrays/members, invalid values and escaped pointers', () => {
  for (const value of [
    { groups: { a: { members: { agent: ['build', 'build'] } } } },
    {
      groups: [{ name: 'a' }, { name: 'a' }],
    },
    { agent: { build: { top_p: 'invalid' } } },
    { profiles: { a: { groups: { x: { members: { agent: ['build'] } } } } } },
  ]) {
    assert.throws(() => read(value));
  }
  const result = resolveComposition(
    read({ agent: { 'a/b~c': { temperature: 0 } } }),
    null,
    { agent: { 'a/b~c': {} } },
    {},
  );
  assert.equal(result.decisions['/agent/a~1b~0c/temperature'].value, 0);
});

test('membership-only groups and unselected profiles do not alter membership; native scalar policy survives empty patches', () => {
  const doc = read({
    groups: { membership: {} },
    agent: { worker: { permission: {} } },
    profiles: { a: { groups: { membership: { agent: { options: { enabled: false } } } } } },
  });
  const base = { agent: { worker: { groups: ['membership'], permission: { '*': 'ask' }, options: { native: true } } } };
  assert.deepEqual(resolveComposition(doc, null, base, {}).agent.worker.permission, { '*': 'ask' });
  assert.deepEqual(resolveComposition(doc, 'a', base, {}).agent.worker.options, { enabled: false });
  assert.deepEqual(resolveComposition(doc, null, base, {}).agent.worker.options, { native: true });
});

test('direct numeric fields match native finite values and JSON-safe options reject infinity and cycles', () => {
  assert.doesNotThrow(() => read({ agent: { build: { temperature: -1, top_p: 2 } } }));
  for (const value of [NaN, Infinity, undefined, () => {}]) {
    assert.throws(() => read({ agent: { build: { options: { value } } } }), /finite JSON/);
  }
  const cycle: Record<string, unknown> = {};
  cycle.value = cycle;
  assert.throws(() => read({ agent: { build: { options: cycle } } }), /cycles/);
  const document = read(parseConfiguration('{"profiles":{"__proto__":{}},"defaultProfile":"__proto__"}'));
  assert.equal(resolveComposition(document, undefined, {}, {}).profile, '__proto__');
});

test('Composer scalar policies append wildcard rules before native hook output', () => {
  const base = { agent: { worker: { permission: { read: 'deny', bash: 'ask' } } } };
  const scalar = resolveComposition(
    read({
      agent: { worker: { permission: 'allow' } },
      profiles: { restricted: { agent: { worker: { permission: { read: 'deny' } } } } },
    }),
    null,
    base,
    {},
  );
  assert.deepEqual(Object.entries(scalar.agent.worker.permission as object), [
    ['read', 'deny'],
    ['bash', 'ask'],
    ['*', 'allow'],
  ]);
  const mapped = resolveComposition(
    read({
      agent: { worker: { permission: 'allow' } },
      profiles: { restricted: { agent: { worker: { permission: { read: 'deny' } } } } },
    }),
    'restricted',
    base,
    {},
  );
  assert.deepEqual(Object.entries(mapped.agent.worker.permission as object), [
    ['bash', 'ask'],
    ['*', 'allow'],
    ['read', 'deny'],
  ]);
  const group = resolveComposition(
    read({ groups: { workers: { agent: { permission: 'ask' } } } }),
    null,
    { agent: { worker: { groups: ['workers'], permission: {} } } },
    {},
  );
  assert.deepEqual(group.agent.worker.permission, { '*': 'ask' });
});

test('native action-only permissions reject pattern maps across every authored layer', () => {
  for (const tool of actionOnlyPermissions) {
    for (const value of [{}, { '*': 'deny' }]) {
      const patch = { permission: { [tool]: value } };
      for (const document of [
        { agent: { worker: patch } },
        { groups: { workers: { agent: patch } } },
        { profiles: { inactive: { agent: { worker: patch } } } },
        {
          groups: { workers: {} },
          profiles: { inactive: { groups: { workers: { agent: patch } } } },
        },
      ]) {
        assert.throws(() => read(document), /Expected a permission action/);
      }
    }
    assert.doesNotThrow(() => read({ agent: { worker: { permission: { [tool]: 'ask' } } } }));
  }
  for (const permission of [{}, { bash: {}, read: { '*.md': 'ask' }, custom_tool: { '*': 'deny' } }]) {
    assert.doesNotThrow(() => read({ agent: { worker: { permission } } }));
  }
});

test('mode rejects singleton and nested arrays, including inactive profile settings', () => {
  for (const mode of [['primary'], ['subagent'], ['all'], [[['primary']]]]) {
    for (const document of [
      { agent: { worker: { mode } } },
      { profiles: { inactive: { agent: { worker: { mode } } } } },
    ]) {
      assert.throws(() => read(document), /Expected primary, subagent or all/);
    }
  }
});
