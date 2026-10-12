import type { PluginInput } from '@opencode-ai/plugin';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';

test('selection defaults replace legacy activation without modifying the source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode'));
  const baseFile = join(root, 'composer.jsonc');
  await writeFile(
    baseFile,
    JSON.stringify({
      profiles: { old: {}, next: {} },
      activeProfiles: ['old'],
      selection: { defaultProfiles: ['next'], retainOnRestart: false },
    }),
  );
  const context = { root, baseFile, baseExplicit: true };
  assert.deepEqual((await loadCompositionSources(context)).activeProfiles, ['next']);
  await writeFile(
    join(root, '.opencode/config-composer.jsonc'),
    JSON.stringify({ selection: { defaultProfiles: [] } }),
  );
  assert.deepEqual((await loadCompositionSources(context)).activeProfiles, []);
});

test('external selection is isolated per project and process lifetime, with stale saves rejected', async (t) => {
  const state = await import('../src/config-composer/composition/selection-state.ts');
  const root = await mkdtemp(join(tmpdir(), 'composer-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first);
  await mkdir(second);
  const environment = { stateDirectory: join(root, 'state'), lifetime: 'process-one' };
  const identity = { root: first, baseFile: join(root, 'config.jsonc') };
  const initial = await state.readSelection(environment, identity, true);
  await state.saveSelection(initial, ['work']);
  assert.deepEqual((await state.readSelection(environment, identity, true)).profiles, ['work']);
  assert.equal((await state.readSelection(environment, { ...identity, root: second }, true)).profiles, undefined);
  await assert.rejects(state.saveSelection(initial, []), /changed/);
  const transient = await state.readSelection(environment, identity, false);
  await state.saveSelection(transient, []);
  assert.deepEqual((await state.readSelection(environment, identity, false)).profiles, []);
  assert.equal(
    (await state.readSelection({ ...environment, lifetime: 'process-two' }, identity, false)).profiles,
    undefined,
  );
  const selected = await state.readSelection(environment, identity, true);
  await state.saveSelection(selected, undefined);
  assert.equal((await state.readSelection(environment, identity, true)).profiles, undefined);
  await writeFile(selected.path, '{broken');
  await assert.rejects(state.readSelection(environment, identity, true), /selection state/);
});

test('source composition consumes external identifiers and keeps authored bytes unchanged', async (t) => {
  const { readSelection, saveSelection } = await import('../src/config-composer/composition/selection-state.ts');
  const root = await mkdtemp(join(tmpdir(), 'composer-selection-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseFile = join(root, 'composer.jsonc');
  const original = '{ "profiles": {"default": {}, "picked": {}}, "selection": {"defaultProfiles": ["default"]} }';
  await writeFile(baseFile, original);
  const selectionEnvironment = { stateDirectory: join(root, 'state'), lifetime: 'one' };
  const snapshot = await readSelection(selectionEnvironment, { root, baseFile }, true);
  await saveSelection(snapshot, ['picked']);
  const loaded = await loadCompositionSources({ root, baseFile, baseExplicit: true, selectionEnvironment });
  assert.deepEqual(loaded.activeProfiles, ['picked']);
  assert.deepEqual(loaded.selectionPolicy.defaultProfiles, ['default']);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(baseFile, 'utf8'), original);
});

test('selection plans preview and save without touching configuration and reject concurrent selections', async (t) => {
  const { loadSnapshot, previewFilePlan, saveFilePlan } = await import('../src/config-composer/storage.ts');
  const { planSelection } = await import('../src/config-composer/composition/activation.ts');
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'composer-selection-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  const nativeText = '{"plugin":["@lunchbox-labs/opencode-config-composer"]}';
  await writeFile(join(root, 'opencode.jsonc'), nativeText);
  const text = '{"profiles":{"first":{},"second":{}},"activeProfiles":["first"]}';
  await writeFile(join(root, 'config-composer.jsonc'), text);
  const native = { selectionEnvironment: { stateDirectory: join(root, 'state'), lifetime: 'one' } };
  const snapshot = await loadSnapshot(root, project, native);
  const plan = planSelection(snapshot, ['second']);
  assert.equal(plan.edits.length, 0);
  assert.deepEqual((await previewFilePlan(plan)).sources.activeProfiles, ['second']);
  await saveFilePlan(plan, async () => {
    await previewFilePlan(plan);
  });
  assert.deepEqual((await loadSnapshot(root, project, native)).sources.activeProfiles, ['second']);
  assert.equal(await readFile(join(root, 'config-composer.jsonc'), 'utf8'), text);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), nativeText);
  await assert.rejects(
    saveFilePlan(plan, async () => {}),
    /changed/,
  );
});

test('renaming an externally selected profile updates identifiers and blocks deletion until deselected', async (t) => {
  const { loadSnapshot, previewFilePlan, saveFilePlan } = await import('../src/config-composer/storage.ts');
  const { planSelection } = await import('../src/config-composer/composition/activation.ts');
  const { planDefinition } = await import('../src/config-composer/composition/authoring.ts');
  const root = await mkdtemp(join(tmpdir(), 'composer-selection-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), '{"plugin":["@lunchbox-labs/opencode-config-composer"]}');
  await writeFile(
    join(root, 'config-composer.jsonc'),
    '{"profiles":{"first":{},"second":{}},"selection":{"defaultProfiles":[]}}',
  );
  const native = { selectionEnvironment: { stateDirectory: join(root, 'state'), lifetime: 'one' } };
  const load = () => loadSnapshot(root, root, native);
  const save = async (plan: ReturnType<typeof planSelection>) =>
    saveFilePlan(plan, async () => {
      await previewFilePlan(plan);
    });
  await save(planSelection(await load(), ['first', 'second']));
  const selected = await load();
  assert.throws(
    () => planDefinition(selected, { operation: 'delete', registry: 'profiles', name: 'first' }),
    /selected/,
  );
  const plan = planDefinition(selected, {
    operation: 'rename',
    registry: 'profiles',
    name: 'first',
    nextName: 'renamed',
  });
  assert.deepEqual((await previewFilePlan(plan)).sources.activeProfiles, ['renamed', 'second']);
  await save(plan);
  assert.deepEqual((await load()).sources.activeProfiles, ['renamed', 'second']);
});

test('server initialization does not call an instance endpoint that waits for plugin bootstrap', async () => {
  const { default: server } = await import('../src/config-composer/server.ts');
  const hooks = await server.server({
    client: {
      path: {
        get: async () => {
          throw new Error('Instance bootstrap recursion');
        },
      },
    },
  } as unknown as PluginInput);
  assert.equal(typeof hooks.config, 'function');
});

test('combined profile rename rolls back definitions if another file edit fails', async (t) => {
  const { loadSnapshot, previewFilePlan, saveFilePlan } = await import('../src/config-composer/storage.ts');
  const { planSelection } = await import('../src/config-composer/composition/activation.ts');
  const { planDefinition } = await import('../src/config-composer/composition/authoring.ts');
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'composer-selection-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), '{"plugin":["@lunchbox-labs/opencode-config-composer"]}');
  const path = join(root, 'config-composer.jsonc');
  const original = '{"profiles":{"first":{}}}';
  await writeFile(path, original);
  const native = { selectionEnvironment: { stateDirectory: join(root, 'state'), lifetime: 'one' } };
  const load = () => loadSnapshot(root, root, native);
  const select = planSelection(await load(), ['first']);
  await saveFilePlan(select, async () => {});
  const snapshot = await load();
  const plan = planDefinition(snapshot, {
    operation: 'rename',
    registry: 'profiles',
    name: 'first',
    nextName: 'renamed',
  });
  plan.edits.push({ ...plan.edits[0], file: { ...plan.edits[0].file, path: join(root, 'absent', 'config.jsonc') } });
  await assert.rejects(
    saveFilePlan(plan, async () => {
      await previewFilePlan(plan);
    }),
    /ENOENT/,
  );
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual((await load()).sources.activeProfiles, ['first']);
});

test('simultaneous state writers cannot lose another process selection', async (t) => {
  const { readSelection, saveSelection } = await import('../src/config-composer/composition/selection-state.ts');
  const root = await mkdtemp(join(tmpdir(), 'composer-selection-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { stateDirectory: join(root, 'state'), lifetime: 'one' };
  const identity = { root, baseFile: join(root, 'composer.jsonc') };
  const state = await readSelection(environment, identity, true);
  const results = await Promise.allSettled([saveSelection(state, ['first']), saveSelection(state, ['second'])]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const persisted = await readSelection(environment, identity, true);
  assert.equal(persisted.revision, 1);
  assert.ok(['first', 'second'].includes(persisted.profiles![0]));
});

test('imported selection policies and unsupported lifecycle options are rejected', async (t) => {
  const { readCompositionDocument } = await import('../src/config-composer/composition/document.ts');
  for (const selection of [
    { retainOnRestart: 'yes' },
    { retainOnNewSession: false },
    { defaultProfiles: ['a', 'a'] },
  ]) {
    assert.throws(() => readCompositionDocument({ selection }));
  }
  const root = await mkdtemp(join(tmpdir(), 'composer-selection-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseFile = join(root, 'composer.jsonc');
  await writeFile(baseFile, '{"imports":["./imported.jsonc"]}');
  await writeFile(join(root, 'imported.jsonc'), '{"selection":{"defaultProfiles":[]}}');
  await assert.rejects(loadCompositionSources({ root, baseFile, baseExplicit: true }), /definitions only/);
});

test('state namespace symlinks cannot redirect reads or writes outside plugin storage', async (t) => {
  const { readSelection, saveSelection } = await import('../src/config-composer/composition/selection-state.ts');
  const { symlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'composer-selection-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { stateDirectory: join(root, 'state'), lifetime: 'one' };
  const identity = { root, baseFile: join(root, 'composer.jsonc') };
  const state = await readSelection(environment, identity, true);
  const external = join(root, 'external');
  await mkdir(external);
  await mkdir(dirname(dirname(state.path)), { recursive: true });
  await symlink(external, dirname(state.path), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(
    join(external, basename(state.path)),
    '{"version":1,"revision":1,"selection":{"mode":"override","profiles":["redirected"]}}',
  );
  await assert.rejects(readSelection(environment, identity, true), /selection state|identity/);
  await assert.rejects(saveSelection(state, []), /identity/);
});

test('selection and definition saves share the configuration transaction lock', async (t) => {
  const { loadSnapshot, saveFilePlan } = await import('../src/config-composer/storage.ts');
  const { planSelection } = await import('../src/config-composer/composition/activation.ts');
  const { planDefinition } = await import('../src/config-composer/composition/authoring.ts');
  const root = await mkdtemp(join(tmpdir(), 'composer-selection-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), '{"plugin":["@lunchbox-labs/opencode-config-composer"]}');
  await writeFile(
    join(root, 'config-composer.jsonc'),
    '{"profiles":{"first":{},"second":{}},"selection":{"defaultProfiles":["first"]}}',
  );
  const native = { selectionEnvironment: { stateDirectory: join(root, 'state'), lifetime: 'one' } };
  const snapshot = await loadSnapshot(root, root, native);
  await saveFilePlan(
    planDefinition(snapshot, { operation: 'delete', registry: 'profiles', name: 'second' }),
    async () => {
      await assert.rejects(
        saveFilePlan(planSelection(snapshot, ['second']), async () => {}),
        /edit is active/,
      );
    },
  );
  assert.deepEqual((await loadSnapshot(root, root, native)).sources.activeProfiles, ['first']);
});

test('server state proof rejects private mounts and redirected proof files', async (t) => {
  const state = await import('../src/config-composer/composition/selection-state.ts');
  const { symlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'composer-state-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { stateDirectory: join(root, 'state'), lifetime: 'server-nonce' };
  await assert.rejects(state.verifySelectionProof(environment), /state filesystem/);
  await state.publishSelectionProof(environment);
  await state.verifySelectionProof(environment);
  await assert.rejects(
    state.verifySelectionProof({ ...environment, stateDirectory: join(root, 'private') }),
    /state filesystem/,
  );
  const proof = join(environment.stateDirectory, 'config-composer/v1/processes/server-nonce/proof');
  await rm(proof);
  const target = join(root, 'outside');
  await writeFile(target, environment.lifetime);
  try {
    await symlink(target, proof);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return;
    }
    throw error;
  }
  await assert.rejects(state.verifySelectionProof(environment), /state filesystem/);
});
