import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageName } from '../src/config-composer/package-name.ts';
import { loadSnapshot, parseConfig, previewFilePlan, saveFilePlan } from '../src/config-composer/storage.ts';
import { planScope, scopeDestinations } from '../src/config-composer/composition/activation.ts';
import { definitionDestinations, planDefinition } from '../src/config-composer/composition/authoring.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'composer-activation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'config');
  const project = join(directory, 'project');
  await mkdir(root);
  await mkdir(project);
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: {
        first: { agents: ['build'], configuration: { model: 'fixture/first' } },
        last: { agents: ['build'], configuration: { model: 'fixture/last' } },
      },
      profiles: { first: { layers: [{ componentGroup: 'first' }] }, last: { layers: [{ componentGroup: 'last' }] } },
      activeProfiles: ['first'],
    }),
  );
  const snapshot = () => loadSnapshot(root, project);
  return { root, project, snapshot };
}

async function save(plan: ReturnType<typeof planScope>) {
  await saveFilePlan(plan, async () => {
    await previewFilePlan(plan);
  });
}

test('local activation creates only its selected scope and replaces shared selection in authored order', async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.root, 'config-composer.jsonc'), 'utf8');
  const plan = planScope(await f.snapshot(), 'local', { operation: 'selection', profiles: ['first', 'last'] });
  const preview = await previewFilePlan(plan);
  assert.deepEqual(preview.sources.activeProfiles, ['first', 'last']);
  assert.equal(preview.resolved.agent.build.model, 'fixture/last');
  await assert.rejects(readFile(join(f.project, '.opencode/config-composer.local.jsonc')), /ENOENT/);
  await save(plan);
  assert.equal((await f.snapshot()).resolved.agent.build.model, 'fixture/last');
  assert.equal(await readFile(join(f.root, 'config-composer.jsonc'), 'utf8'), original);
  await assert.rejects(readFile(join(f.project, '.opencode/config-composer.jsonc')), /ENOENT/);
});

test('explicit none and inherited activation stay distinct and preserve unrelated JSONC settings', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, '.opencode'));
  const path = join(f.project, '.opencode/config-composer.local.jsonc');
  await writeFile(path, '{\n // Keep this\n "defaults":{"model":"fixture/native"}, "activeProfiles":["last"],\n}\n');
  await save(planScope(await f.snapshot(), 'local', { operation: 'selection', profiles: [] }));
  assert.deepEqual((await f.snapshot()).sources.activeProfiles, []);
  assert.equal((await f.snapshot()).resolved.model, 'fixture/native');
  await save(planScope(await f.snapshot(), 'local', { operation: 'selection' }));
  assert.deepEqual((await f.snapshot()).sources.activeProfiles, ['first']);
  assert.match(await readFile(path, 'utf8'), /Keep this/);
  assert.doesNotMatch(await readFile(path, 'utf8'), /activeProfiles/);
});

test('scope creation adds a reusable authoring destination without selecting profiles', async (t) => {
  const f = await fixture(t);
  await save(planScope(await f.snapshot(), 'project', { operation: 'create' }));
  const snapshot = await f.snapshot();
  const sourceId = join(f.project, '.opencode/config-composer.jsonc');
  assert.ok(definitionDestinations(snapshot).some((file) => file.path === sourceId));
  assert.deepEqual(snapshot.sources.activeProfiles, ['first']);
  const plan = planDefinition(snapshot, { operation: 'create', registry: 'profiles', name: 'review', sourceId });
  await saveFilePlan(plan, async () => {
    await previewFilePlan(plan);
  });
  assert.deepEqual((await f.snapshot()).sources.registry.profiles?.review, { layers: [] });
});

test('scope descriptions show local masking and ordered inherited selection', async (t) => {
  const f = await fixture(t);
  await save(planScope(await f.snapshot(), 'project', { operation: 'selection', profiles: ['last', 'first'] }));
  await save(planScope(await f.snapshot(), 'local', { operation: 'selection', profiles: [] }));
  const destinations = scopeDestinations(await f.snapshot());
  assert.deepEqual(destinations.find((scope) => scope.scope === 'project')?.selection, ['last', 'first']);
  assert.equal(destinations.find((scope) => scope.scope === 'project')?.maskedBy, 'local');
  assert.deepEqual(destinations.find((scope) => scope.scope === 'local')?.inherited, ['last', 'first']);
});

test('concurrent file creation and unknown profiles are rejected before creating scope files', async (t) => {
  const f = await fixture(t);
  const invalid = planScope(await f.snapshot(), 'local', { operation: 'selection', profiles: ['missing'] });
  await assert.rejects(save(invalid), /Unknown profile/);
  const plan = planScope(await f.snapshot(), 'local', { operation: 'selection', profiles: [] });
  await mkdir(join(f.project, '.opencode'));
  const path = join(f.project, '.opencode/config-composer.local.jsonc');
  await writeFile(path, '{"activeProfiles":["last"]}');
  await assert.rejects(save(plan), /changed/i);
  assert.equal(await readFile(path, 'utf8'), '{"activeProfiles":["last"]}');
});

test('scope creation rejects symlink parent escapes and leaves external files untouched', async (t) => {
  const f = await fixture(t);
  const external = join(f.root, 'external');
  await mkdir(external);
  const plan = planScope(await f.snapshot(), 'local', { operation: 'selection', profiles: [] });
  await symlink(external, join(f.project, '.opencode'));
  await assert.rejects(save(plan), /directory|identity|symbolic/i);
  await assert.rejects(readFile(join(external, 'config-composer.local.jsonc')), /ENOENT/);
});

test('failed authorization never creates a scope directory or file', async (t) => {
  const f = await fixture(t);
  const plan = planScope(await f.snapshot(), 'local', { operation: 'selection', profiles: [] });
  await assert.rejects(
    saveFilePlan(
      plan,
      async () => {
        await previewFilePlan(plan);
      },
      async () => {
        throw new Error('Project filesystem proof failed');
      },
    ),
    /proof failed/,
  );
  await assert.rejects(readFile(join(f.project, '.opencode/config-composer.local.jsonc')), /ENOENT/);
});

test('deleting a captured import during validation aborts without creating a scope file', async (t) => {
  const f = await fixture(t);
  const imported = join(f.root, 'profiles.jsonc');
  await writeFile(imported, '{"profiles":{"review":{"layers":[]}}}');
  const source = join(f.root, 'config-composer.jsonc');
  const value = parseConfig(await readFile(source, 'utf8'));
  value.imports = ['./profiles.jsonc'];
  await writeFile(source, JSON.stringify(value));
  const plan = planScope(await f.snapshot(), 'local', { operation: 'selection', profiles: [] });
  await assert.rejects(
    saveFilePlan(plan, async () => {
      await rm(imported);
      await previewFilePlan(plan);
    }),
    /read|identity|changed/i,
  );
  await assert.rejects(readFile(join(f.project, '.opencode/config-composer.local.jsonc')), /ENOENT/);
});

test('the editor can explicitly create its first optional scope but still rejects explicit missing sources', async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, 'config-composer.jsonc'));
  const snapshot = await f.snapshot();
  assert.deepEqual(snapshot.sources.scopes, []);
  await save(planScope(snapshot, 'project', { operation: 'create' }));
  assert.equal((await f.snapshot()).sources.scopes.length, 1);
  await writeFile(
    join(f.root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [[packageName, { configFile: 'missing.jsonc' }]] }),
  );
  await assert.rejects(f.snapshot(), /Could not read composition source/);
});
