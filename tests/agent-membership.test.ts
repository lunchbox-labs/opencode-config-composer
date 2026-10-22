import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { PluginInput } from '@opencode-ai/plugin';
import descriptor from '../src/config-composer/server.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { readRuntimeContext } from '../src/config-composer/composition/runtime-baseline.ts';
import { readSelectionAt, saveSelection } from '../src/config-composer/composition/selection-state.ts';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { resolveComposition } from '../src/config-composer/composition/runtime.ts';
import { readNativeAgentFrontmatter } from '../src/config-composer/frontmatter.ts';

const document = () =>
  readCompositionDocument({
    groups: [
      {
        name: 'first',
        agent: { model: 'p/first', permission: { read: 'ask', bash: { '*': 'deny', 'git *': 'allow' } } },
      },
      { name: 'last', agent: { model: 'p/last', permission: { bash: { '*': 'ask' }, edit: 'deny' } } },
    ],
    profiles: {
      a: {
        groups: [
          { name: 'last', agent: { variant: 'last' } },
          { name: 'first', agent: { model: 'p/profile', permission: { bash: 'allow' } } },
        ],
      },
      b: { groups: [{ name: 'first', agent: { model: 'p/b' } }] },
    },
  });

test('agent order owns shared and profile precedence independently of catalog or profile array order', () => {
  const native = { agent: { forward: { groups: ['first', 'last'] }, reverse: { groups: ['last', 'first'] } } };
  const result = resolveComposition(document(), 'a', native, {});
  assert.equal(result.agent.forward.model, 'p/last');
  assert.equal(result.agent.reverse.model, 'p/profile');
  assert.deepEqual(result.agent.forward.permission, { read: 'ask', bash: { '*': 'ask' }, edit: 'deny' });
  assert.deepEqual(Object.keys(result.agent.reverse.permission as object), ['edit', 'read', 'bash']);
  assert.equal(result.decisions['/agent/forward/model'].origin.pointer, '/groups/1/agent/model');
  assert.equal(result.decisions['/agent/reverse/model'].origin.pointer, '/profiles/a/groups/1/agent/model');
  assert.deepEqual(native.agent.forward.groups, ['first', 'last']);
});

test('membership metadata is consumed without reaching native fields or provider options', () => {
  const result = resolveComposition(
    document(),
    null,
    {
      agent: {
        worker: { groups: ['first'], options: { groups: ['first'], reasoning: false } },
        unrelated: { options: { groups: ['last'], keep: 0 } },
      },
    },
    {},
  );
  assert.equal(result.agent.worker.groups, undefined);
  assert.deepEqual(result.agent.worker.options, { reasoning: false });
  assert.equal(result.agent.unrelated.model, undefined);
  assert.deepEqual(result.agent.unrelated.options, { keep: 0 });
});

test('membership arrays reject unknown, duplicate and invalid names, and central members are rejected', () => {
  for (const groups of ['first', ['first', 'first'], ['unknown'], [''], [' '], [false], [0], [null]]) {
    assert.throws(() => resolveComposition(document(), null, { agent: { worker: { groups } } }, {}), /group/i);
  }
  assert.throws(
    () => readCompositionDocument({ groups: [{ name: 'first', members: { agent: ['build'] } }] }),
    /Unknown key/,
  );
  assert.throws(
    () => readCompositionDocument({ groups: [{ name: 'first', command: { model: 'p/model' } }] }),
    /Unknown key/,
  );
  assert.throws(
    () => readCompositionDocument({ profiles: { inactive: { agent: { build: { options: { groups: [] } } } } } }),
    /groups/,
  );
});

test('Markdown membership wins as a whole array and does not become an options pin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-membership-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agents'));
  await writeFile(join(root, 'agents/worker.md'), '---\ngroups: [last, first]\ntemperature: 0\n---\nopaque body');
  const authority = Object.fromEntries(
    await readNativeAgentFrontmatter({
      directory: root,
      worktree: root,
      home: root,
      environment: { OPENCODE_CONFIG_DIR: root, XDG_CONFIG_HOME: root, OPENCODE_TEST_HOME: root },
    }),
  );
  assert.equal(authority.worker.fields.options, undefined);
  const definitions = document();
  definitions.groups[0].agent = { ...definitions.groups[0].agent, options: { group: false, count: 0 } };
  const result = resolveComposition(
    definitions,
    'a',
    { agent: { worker: { groups: ['first', 'last'], options: { groups: ['first', 'last'] } } } },
    authority,
  );
  assert.equal(result.agent.worker.model, 'p/profile');
  assert.equal(result.agent.worker.temperature, 0);
  assert.deepEqual(result.agent.worker.options, { group: false, count: 0 });
  await writeFile(join(root, 'agents/worker.md'), '---\ngroups: []\noptions: {}\npermission: deny\n---\nopaque body');
  const cleared = Object.fromEntries(
    await readNativeAgentFrontmatter({
      directory: root,
      worktree: root,
      home: root,
      environment: { OPENCODE_CONFIG_DIR: root, XDG_CONFIG_HOME: root, OPENCODE_TEST_HOME: root },
    }),
  );
  const empty = resolveComposition(document(), 'a', { agent: { worker: { groups: ['first'] } } }, cleared);
  assert.equal(empty.agent.worker.model, undefined);
  assert.deepEqual(empty.agent.worker.options, {});
  assert.deepEqual(empty.agent.worker.permission, { '*': 'deny' });
});

async function hookFixture(t: TestContext, definition: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'composer-membership-hook-'));
  const keys = ['OPENCODE_CONFIG_DIR', 'OPENCODE_TEST_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'];
  const before = keys.map((key) => process.env[key]);
  keys.forEach((key) => (process.env[key] = root));
  t.after(async () => {
    keys.forEach((key, index) => {
      if (before[index] === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = before[index];
      }
    });
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'config-composer.jsonc'), JSON.stringify(definition));
  const hook = (await descriptor.server({ directory: root, worktree: root } as PluginInput)).config!;
  const config = {
    plugin: [packageName],
    agent: { worker: { groups: ['first'], options: { groups: ['first'], native: false }, prompt: 'opaque' } },
  };
  return { root, hook, config, location: { root, directory: root } };
}

for (const definition of [{ groups: [{ name: 'first', members: { agent: ['worker'] } }] }, { groups: [] }]) {
  test('failed bootstrap strips reserved metadata without applying settings or discarding other native fields', async (t) => {
    const f = await hookFixture(t, definition);
    const sharedAgent = f.config.agent.worker;
    const sharedOptions = sharedAgent.options;
    await assert.rejects(f.hook(f.config));
    assert.deepEqual(sharedAgent.groups, ['first']);
    assert.deepEqual(sharedOptions.groups, ['first']);
    assert.notEqual(f.config.agent.worker, sharedAgent);
    assert.equal(Object.hasOwn(f.config.agent.worker, 'groups'), false);
    assert.deepEqual(f.config.agent.worker.options, { native: false });
    assert.equal(f.config.agent.worker.prompt, 'opaque');
  });
}

test('same and reused nested objects retain membership through A B A none and sanitize failed recomposition', async (t) => {
  const f = await hookFixture(t, { ...document(), defaultProfile: 'a' });
  for (const choice of ['a', 'b', 'a', null] as const) {
    const hooks = f.hook;
    if (choice !== 'a' || Object.hasOwn(f.config.agent.worker, 'model')) {
      const runtime = readRuntimeContext(f.config, f.location);
      const selection = await readSelectionAt(runtime.selectionEnvironment, runtime.selectionLocator);
      await saveSelection(selection, choice, async () => {});
    }
    await hooks(f.config);
    const runtime = readRuntimeContext(f.config, f.location);
    assert.deepEqual(runtime.candidate?.memberships.worker?.groups, ['first']);
    assert.equal(
      runtime.candidate.agent.worker.model,
      choice === 'a' ? 'p/profile' : choice === 'b' ? 'p/b' : 'p/first',
    );
    assert.equal(Object.hasOwn(f.config.agent.worker, 'groups'), false);
    assert.deepEqual(f.config.agent.worker.options, { native: false });
  }
  const nested = f.config.agent.worker;
  const replacement = { plugin: [packageName], agent: { worker: nested } };
  await f.hook(replacement);
  assert.deepEqual(readRuntimeContext(replacement, f.location).candidate?.memberships.worker?.groups, ['first']);
  Object.assign(replacement.agent.worker, { groups: ['missing'] });
  Object.assign(replacement.agent.worker.options, { groups: ['missing'] });
  await assert.rejects(f.hook(replacement), /unknown group/);
  assert.equal(Object.hasOwn(replacement.agent.worker, 'groups'), false);
  assert.deepEqual(replacement.agent.worker.options, { native: false });
  const failed = readRuntimeContext(replacement, f.location);
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.native.agent?.worker.groups, ['missing']);
});

test('later Markdown source keeps an absent membership and an explicit empty array clears it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-membership-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode/agents'), { recursive: true });
  await mkdir(join(root, 'agents'));
  const first = join(root, '.opencode/agents/worker.md');
  const last = join(root, 'agents/worker.md');
  await writeFile(first, '---\ngroups: [first]\n---\nfirst');
  await writeFile(last, '---\nmodel: p/pinned\noptions:\n  groups: [ignored]\n  enabled: false\n---\nlast');
  const context = {
    directory: root,
    worktree: root,
    home: root,
    environment: { OPENCODE_CONFIG_DIR: root, XDG_CONFIG_HOME: root, OPENCODE_TEST_HOME: root },
  };
  const authority = Object.fromEntries(await readNativeAgentFrontmatter(context));
  assert.deepEqual(authority.worker.groups?.value, ['first']);
  assert.equal(authority.worker.groups.source.path, first);
  assert.deepEqual(authority.worker.fields.options?.value, { enabled: false });
  assert.deepEqual(authority.worker.fields.options.authored, { options: { enabled: false } });
  const result = resolveComposition(document(), 'a', { agent: { worker: { groups: ['last'] } } }, authority);
  assert.equal(result.agent.worker.model, 'p/pinned');
  assert.deepEqual(result.memberships.worker?.groups, ['first']);
  assert.deepEqual(result.agent.worker.options, { enabled: false });
  await writeFile(last, '---\ngroups: []\n---\nlast');
  const clear = Object.fromEntries(await readNativeAgentFrontmatter(context));
  assert.deepEqual(clear.worker.groups?.value, []);
  assert.equal(clear.worker.groups.source.path, last);
});

test('invalid native membership is stripped on failure while the error attests original metadata', async (t) => {
  const f = await hookFixture(t, document());
  Object.assign(f.config.agent.worker, { groups: 'first' });
  await assert.rejects(f.hook(f.config), /groups must be an array/);
  assert.equal(Object.hasOwn(f.config.agent.worker, 'groups'), false);
  assert.deepEqual(f.config.agent.worker.options, { native: false });
  const runtime = readRuntimeContext(f.config, f.location);
  assert.equal(runtime.status, 'error');
  assert.equal(runtime.native.agent?.worker.groups, 'first');
});

test('a failed sanitized object and its reused agent retain invalid membership until genuinely replaced', async (t) => {
  const f = await hookFixture(t, document());
  Object.assign(f.config.agent.worker, { groups: ['missing'] });
  await assert.rejects(f.hook(f.config), /unknown group/);
  await assert.rejects(f.hook(f.config), /unknown group/);
  const reused = { plugin: [packageName], agent: { worker: f.config.agent.worker } };
  await assert.rejects(f.hook(reused), /unknown group/);
  assert.deepEqual(readRuntimeContext(reused, f.location).native.agent?.worker.groups, ['missing']);
  Object.assign(reused.agent.worker, { groups: ['first'] });
  await f.hook(reused);
  assert.deepEqual(readRuntimeContext(reused, f.location).candidate?.memberships.worker?.groups, ['first']);
  assert.equal(Object.hasOwn(reused.agent.worker, 'groups'), false);
});

test('recovering a saved profile error preserves valid groups in reused root and nested objects', async (t) => {
  const f = await hookFixture(t, document());
  await f.hook(f.config);
  const initial = readRuntimeContext(f.config, f.location);
  await saveSelection(
    await readSelectionAt(initial.selectionEnvironment, initial.selectionLocator),
    'missing',
    async () => {},
  );
  await assert.rejects(f.hook(f.config), /Saved profile missing/);
  await assert.rejects(f.hook(f.config), /Saved profile missing/);
  const reused = { plugin: [packageName], agent: { worker: f.config.agent.worker } };
  await assert.rejects(f.hook(reused), /Saved profile missing/);
  const failed = readRuntimeContext(reused, f.location);
  assert.deepEqual(failed.native.agent?.worker.groups, ['first']);
  await saveSelection(await readSelectionAt(failed.selectionEnvironment, failed.selectionLocator), 'b', async () => {});
  await f.hook(reused);
  const recovered = readRuntimeContext(reused, f.location);
  assert.equal(recovered.status, 'applied');
  assert.deepEqual(recovered.candidate?.memberships.worker?.groups, ['first']);
  assert.equal(recovered.candidate.agent.worker.model, 'p/b');
  assert.deepEqual(recovered.candidate.agent.worker.permission, {
    read: 'ask',
    bash: { '*': 'deny', 'git *': 'allow' },
  });
});
