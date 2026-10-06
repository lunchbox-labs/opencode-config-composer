import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { type TestContext, test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSnapshot,
  memberships,
  planChange,
  plannedChoices,
  reloadConfiguration,
  savePlan,
} from '../src/config-composer/storage.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { parseCompositionDocument } from '../src/config-composer/composition/document.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-canonical-editor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agents'));
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({
      plugin: [packageName],
      model: 'fixture/native',
      agent: { worker: { groups: ['work'], prompt: 'Body' } },
    }),
  );
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: {
        work: {
          agents: ['build'],
          configuration: {
            modelRef: 'preset:balanced',
            permissions: [{ tool: 'bash', action: 'ask' }],
            parameters: { temperature: 0.2 },
          },
        },
      },
      configurationPresets: {
        balanced: {
          model: 'fixture/a',
          variant: 'high',
          permissions: [{ tool: 'edit', action: 'deny' }],
          parameters: { maxOutputTokens: 128 },
        },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  return root;
}

test('canonical editor opens selected built-ins and custom agents and preserves mixed preset settings on model edits', async (t) => {
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  assert.ok(snapshot.agents.some((agent) => agent.name === 'build'));
  assert.ok(snapshot.agents.some((agent) => agent.name === 'worker'));
  const plan = planChange(snapshot, {
    kind: 'preset',
    name: 'balanced',
    choice: { model: 'fixture/b', variant: 'low' },
  });
  await savePlan(plan);
  const value = parseCompositionDocument(await readFile(join(root, 'config-composer.jsonc'), 'utf8'));
  assert.equal(value.configurationPresets!.balanced.model, 'fixture/b');
  assert.deepEqual(value.configurationPresets!.balanced.permissions, [{ tool: 'edit', action: 'deny' }]);
  assert.deepEqual(value.configurationPresets!.balanced.parameters, { maxOutputTokens: 128 });
  assert.deepEqual(value.activeProfiles, ['work']);
});

test('canonical group edits preserve membership, parameters, permission contributions and prompt operations', async (t) => {
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  await savePlan(planChange(snapshot, { kind: 'group', name: 'work', choice: { model: 'fixture/c' } }));
  const value = parseCompositionDocument(await readFile(join(root, 'config-composer.jsonc'), 'utf8'));
  assert.deepEqual(value.componentGroups!.work.agents, ['build']);
  assert.equal(value.componentGroups!.work.configuration!.model, 'fixture/c');
  assert.equal(value.componentGroups!.work.configuration!.modelRef, undefined);
  assert.deepEqual(value.componentGroups!.work.configuration!.permissions, [{ tool: 'bash', action: 'ask' }]);
  assert.deepEqual(value.componentGroups!.work.configuration!.parameters, { temperature: 0.2 });
});

test('model previews follow active profile order and include preset layers rather than frontmatter order', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: {
        one: { agents: ['worker'], configuration: { model: 'fixture/a' } },
        two: { agents: ['worker'], configuration: { model: 'fixture/b' } },
      },
      configurationPresets: { last: { model: 'fixture/final' } },
      profiles: {
        work: {
          layers: [
            { componentGroup: 'two' },
            { componentGroup: 'one' },
            { configurationPreset: 'last', target: { agents: ['worker'] } },
          ],
        },
      },
      activeProfiles: ['work'],
    }),
  );
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [packageName], model: 'fixture/native', agent: { worker: { groups: ['one', 'two'] } } }),
  );
  const snapshot = await loadSnapshot(root);
  const choices = await plannedChoices(
    planChange(snapshot, { kind: 'group', name: 'one', choice: { model: 'fixture/c' } }),
  );
  assert.ok(choices.some((choice) => choice.model === 'fixture/final'));
});

test('imported definitions edit their declaring file and all preset references prevent deletion', async (t) => {
  const root = await fixture(t);
  const imported = join(root, 'presets.jsonc');
  await writeFile(
    imported,
    JSON.stringify({
      configurationPresets: {
        inherited: { model: 'fixture/a', permissions: [{ tool: 'edit', action: 'ask' }] },
        child: { modelRef: 'preset:inherited' },
      },
    }),
  );
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      imports: ['./presets.jsonc'],
      componentGroups: { work: { agents: ['build'] } },
      profiles: {
        work: { layers: [{ componentGroup: 'work' }, { configurationPreset: 'child', target: { agents: ['build'] } }] },
      },
      activeProfiles: ['work'],
    }),
  );
  const snapshot = await loadSnapshot(root);
  assert.throws(() => planChange(snapshot, { kind: 'deletePreset', name: 'inherited' }), /Reassign/);
  assert.throws(() => planChange(snapshot, { kind: 'deletePreset', name: 'child' }), /Reassign/);
  const plan = planChange(snapshot, { kind: 'preset', name: 'inherited', choice: { model: 'fixture/b' } });
  assert.deepEqual(
    plan.edits.map((edit) => edit.file.path),
    [imported],
  );
  await savePlan(plan);
  const updated = parseCompositionDocument(await readFile(imported, 'utf8'));
  assert.deepEqual(updated.configurationPresets!.inherited.permissions, [{ tool: 'edit', action: 'ask' }]);
  assert.equal((await loadSnapshot(root)).resolved.choices.build.model, 'fixture/b');
});

test('outside imports remain read-only and participate in stale snapshot detection', async (t) => {
  const root = await fixture(t);
  const foreign = await mkdtemp(join(tmpdir(), 'composer-readonly-'));
  t.after(() => rm(foreign, { recursive: true, force: true }));
  const path = join(foreign, 'source.jsonc');
  await writeFile(path, JSON.stringify({ configurationPresets: { shared: { model: 'fixture/a' } } }));
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      imports: [path],
      componentGroups: { work: { agents: ['build'], configuration: { modelRef: 'preset:shared' } } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const snapshot = await loadSnapshot(root);
  assert.throws(
    () => planChange(snapshot, { kind: 'preset', name: 'shared', choice: { model: 'fixture/b' } }),
    /Read-only composition source/,
  );
  await savePlan(planChange(snapshot, { kind: 'group', name: 'work', choice: { model: 'fixture/c' } }));
  const next = await loadSnapshot(root);
  const pending = planChange(next, { kind: 'global', field: 'model', model: 'fixture/b' });
  await writeFile(path, (await readFile(path, 'utf8')) + '\n// External edit');
  await assert.rejects(savePlan(pending), /Settings changed/);
});

test('membership combines JSONC and frontmatter and clearing removes both without changing activation', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      components: { agents: { custom: { prompt: 'Component body', configuration: { model: 'fixture/pinned' } } } },
      componentGroups: {
        work: { agents: ['worker', 'custom'], configuration: { model: 'fixture/a' } },
        next: { configuration: { model: 'fixture/b' } },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }, { componentGroup: 'next' }] } },
      activeProfiles: ['work'],
    }),
  );
  let snapshot = await loadSnapshot(root);
  assert.deepEqual(
    memberships(
      snapshot,
      snapshot.agents.find((agent) => agent.name === 'worker')!,
    ),
    ['work'],
  );
  await savePlan(planChange(snapshot, { kind: 'membership', agent: 'worker', groups: [] }));
  snapshot = await loadSnapshot(root);
  assert.deepEqual(
    memberships(
      snapshot,
      snapshot.agents.find((agent) => agent.name === 'worker')!,
    ),
    [],
  );
  assert.deepEqual(snapshot.sources.activeProfiles, ['work']);
  await savePlan(planChange(snapshot, { kind: 'membership', agent: 'custom', groups: ['next'] }));
  snapshot = await loadSnapshot(root);
  assert.deepEqual(
    memberships(
      snapshot,
      snapshot.agents.find((agent) => agent.name === 'custom')!,
    ),
    ['next'],
  );
  await savePlan(planChange(snapshot, { kind: 'override', agent: 'custom', choice: {} }));
  snapshot = await loadSnapshot(root);
  assert.equal(snapshot.resolved.choices.custom.model, 'fixture/b');
  assert.equal(snapshot.sources.registry.components?.agents?.custom.prompt, 'Component body');
});

test('local empty activation wins in editor previews and group edits do not activate profiles', async (t) => {
  const root = await fixture(t);
  const project = join(root, 'project');
  await mkdir(join(project, '.opencode'), { recursive: true });
  await writeFile(join(project, '.opencode/config-composer.local.jsonc'), '{"activeProfiles":[]}');
  const snapshot = await loadSnapshot(root, project);
  assert.deepEqual(snapshot.resolved.selectedAgents, []);
  await savePlan(planChange(snapshot, { kind: 'group', name: 'work', choice: { model: 'fixture/c' } }));
  assert.deepEqual((await loadSnapshot(root, project)).resolved.selectedAgents, []);
  assert.equal(await readFile(join(project, '.opencode/config-composer.local.jsonc'), 'utf8'), '{"activeProfiles":[]}');
});

test('inline component membership survives creation of an inactive group', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      components: { agents: { custom: { prompt: 'Body' } } },
      componentGroups: { work: {} },
      activeProfiles: [],
    }),
  );
  const snapshot = await loadSnapshot(root);
  await savePlan(planChange(snapshot, { kind: 'membership', agent: 'custom', groups: ['new-group'] }));
  const current = await loadSnapshot(root);
  assert.deepEqual(current.sources.registry.componentGroups!['new-group'].agents, ['custom']);
  assert.deepEqual(
    memberships(
      current,
      current.agents.find((agent) => agent.name === 'custom')!,
    ),
    ['new-group'],
  );
  assert.deepEqual(current.sources.activeProfiles, []);
});

test('read-only component aliases allow unrelated edits but detect identity changes', async (t) => {
  const root = await fixture(t);
  const original = join(root, 'component.md');
  const other = join(root, 'other.md');
  const alias = join(root, 'alias.md');
  const text = '---\ndescription: Shared body\n---\nPrompt';
  await writeFile(original, text);
  await writeFile(other, text);
  await symlink(original, alias);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      components: { agents: { custom: { file: './alias.md' } } },
      componentGroups: { work: { agents: ['custom'] } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const snapshot = await loadSnapshot(root);
  await savePlan(planChange(snapshot, { kind: 'global', field: 'model', model: 'fixture/b' }));
  const current = await loadSnapshot(root);
  const plan = planChange(current, { kind: 'global', field: 'model', model: 'fixture/c' });
  await rm(alias);
  await symlink(other, alias);
  await assert.rejects(savePlan(plan), /identity changed/);
});

test('concrete component overrides preserve shared read-only Markdown and other component variants', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'shared-agent.md');
  const original = '---\nmodel: fixture/old\nvariant: low\n---\nShared body';
  await writeFile(path, original);
  await chmod(path, 0o444);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      components: { agents: { one: { file: './shared-agent.md' }, two: { file: './shared-agent.md' } } },
      componentGroups: { work: { agents: ['one', 'two'] } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const snapshot = await loadSnapshot(root);
  const plan = planChange(snapshot, { kind: 'override', agent: 'one', choice: { model: 'fixture/new' } });
  assert.deepEqual(
    plan.edits.map((edit) => edit.file.path),
    [snapshot.settingsFile.path],
  );
  await savePlan(plan);
  const current = await loadSnapshot(root);
  assert.equal(current.resolved.agent.one.model, 'fixture/new');
  assert.equal(current.resolved.agent.one.variant, undefined);
  assert.equal(current.resolved.agent.two.model, 'fixture/old');
  assert.equal(current.resolved.agent.two.variant, 'low');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.throws(() => planChange(current, { kind: 'override', agent: 'one', choice: {} }), /shared by multiple agents/);
});

for (const kind of ['composition', 'component'] as const) {
  test(`snapshot rejects a concurrent ${kind} edit between filesystem reads`, async (t) => {
    const root = await fixture(t);
    const path = join(root, kind === 'composition' ? 'config-composer.jsonc' : 'custom.md');
    if (kind === 'component') {
      await writeFile(path, '---\ndescription: Custom agent\n---\nOriginal prompt');
      await writeFile(
        join(root, 'config-composer.jsonc'),
        JSON.stringify({
          components: { agents: { custom: { file: './custom.md' } } },
          componentGroups: { work: { agents: ['custom'] } },
          profiles: { work: { layers: [{ componentGroup: 'work' }] } },
          activeProfiles: ['work'],
        }),
      );
    }
    const before = await readFile(path, 'utf8');
    const changed =
      kind === 'composition'
        ? before.replace('["build"]', '["build","plan"]')
        : before.replace('Original prompt', 'Concurrent new prompt');
    assert.notEqual(changed, before);
    const originalOpen = fs.promises.open;
    let reads = 0;
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === path) {
        const originalRead = handle.readFile.bind(handle);
        handle.readFile = (async (...readArgs: Parameters<typeof originalRead>) => {
          const bytes = await originalRead(...readArgs);
          if (++reads === 1) {
            await writeFile(path, changed);
          }
          return bytes;
        }) as typeof handle.readFile;
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(loadSnapshot(root), /changed while loading/);
      assert.ok(reads > 0);
      assert.equal(await readFile(path, 'utf8'), changed);
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
  });
}

test('an absent optional shared file permits project-only editor snapshots and native default edits', async (t) => {
  const root = await fixture(t);
  const project = await mkdtemp(join(tmpdir(), 'composer-project-only-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, '.opencode'), { recursive: true });
  const source = join(project, '.opencode/config-composer.jsonc');
  await writeFile(source, await readFile(join(root, 'config-composer.jsonc'), 'utf8'));
  await rm(join(root, 'config-composer.jsonc'));
  const snapshot = await loadSnapshot(root, project);
  assert.equal(snapshot.sourceContext.baseExplicit, false);
  assert.equal(snapshot.settingsFile.path, source);
  assert.equal(snapshot.settingsFile.writable, false);
  await savePlan(planChange(snapshot, { kind: 'global', field: 'model', model: 'fixture/changed' }));
  assert.equal((await loadSnapshot(root, project)).config.model, 'fixture/changed');
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [[packageName, { configFile: 'missing.jsonc' }]] }),
  );
  await assert.rejects(loadSnapshot(root, project), /Could not read composition source/);
});

test('retargeting an imported JSONC alias blocks reload before the host is changed', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const first = join(root, 'first.jsonc');
  const second = join(root, 'second.jsonc');
  const alias = join(root, 'alias.jsonc');
  await writeFile(first, '{"configurationPresets":{"one":{"model":"fixture/first"}}}');
  await writeFile(second, '{"configurationPresets":{"one":{"model":"fixture/second"}}}');
  await symlink(first, alias);
  await writeFile(
    path,
    JSON.stringify({
      imports: ['./alias.jsonc'],
      componentGroups: { work: { agents: ['build'], configuration: { modelRef: 'preset:one' } } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const snapshot = await loadSnapshot(root);
  await rm(alias);
  await symlink(second, alias);
  let updates = 0;
  await assert.rejects(
    reloadConfiguration(snapshot, async () => {
      updates++;
    }),
    /identity changed/,
  );
  assert.equal(updates, 0);
});

test('retargeting a deduplicated project scope alias blocks reload before the host is changed', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.opencode'));
  const alias = join(root, '.opencode/config-composer.jsonc');
  await symlink(join(root, 'config-composer.jsonc'), alias);
  const snapshot = await loadSnapshot(root);
  const second = join(root, 'second.jsonc');
  await writeFile(second, '{"activeProfiles":[]}');
  await rm(alias);
  await symlink(second, alias);
  let updates = 0;
  await assert.rejects(
    reloadConfiguration(snapshot, async () => {
      updates++;
    }),
    /identity changed/,
  );
  assert.equal(updates, 0);
});

test('adding a previously absent local selection blocks reload before the host is changed', async (t) => {
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  await mkdir(join(root, '.opencode'));
  await writeFile(join(root, '.opencode/config-composer.local.jsonc'), '{"activeProfiles":[]}');
  let updates = 0;
  await assert.rejects(
    reloadConfiguration(snapshot, async () => {
      updates++;
    }),
    /identity changed/,
  );
  assert.equal(updates, 0);
});
