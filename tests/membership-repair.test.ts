import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config, PluginInput } from '@opencode-ai/plugin';
import server from '../src/server.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { loadEditorSnapshot, loadSnapshot, previewFilePlan, saveFilePlan } from '../src/config-composer/storage.ts';
import { planDefinition } from '../src/config-composer/composition/authoring.ts';
import { planScope } from '../src/config-composer/composition/activation.ts';
import { readRuntimeBaseline } from '../src/config-composer/composition/runtime-baseline.ts';
import { parseCompositionDocument } from '../src/config-composer/composition/document.ts';
import { planMembershipRepair } from '../src/config-composer/composition/membership-repair.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode'));
  const native: Config = {
    plugin: [packageName],
    model: 'fixture/native',
    agent: { dormant: { disable: true, model: 'fixture/pinned', prompt: 'Retain native body' } },
  };
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify(native));
  const file = join(root, 'config-composer.jsonc');
  await writeFile(
    file,
    `{
    // Retain this comment and explicit activation.
    "componentGroups": { "work": { "agents": ["removed", "dormant", "build"], "configuration": {"model":"fixture/composed"} } },
    "profiles": { "work": { "layers": [{"componentGroup":"work"}] } },
    "activeProfiles": ["work"]
  }`,
  );
  return { root, file, native };
}

test('repair capture retains unresolved sources while normal snapshots still reject invalid active members', async (t) => {
  const f = await fixture(t);
  await assert.rejects(loadSnapshot(f.root), /removed.*unavailable/);
  const snapshot = await loadEditorSnapshot(f.root);
  assert.ok('diagnostic' in snapshot);
  assert.equal(snapshot.diagnostic.group, 'work');
  assert.match(snapshot.diagnostic.message, /removed.*unavailable/);
  assert.equal('resolved' in snapshot, false, 'no fabricated effective state');
  assert.deepEqual(snapshot.sources.activeProfiles, ['work']);
  assert.deepEqual(snapshot.sources.registry.componentGroups?.work.agents, ['removed', 'dormant', 'build']);
  const plan = planDefinition(snapshot, {
    operation: 'patch',
    registry: 'componentGroups',
    name: 'work',
    path: ['agents'],
    value: ['build'],
  });
  assert.equal((await previewFilePlan(plan)).resolved.agent.build.model, 'fixture/composed');
  await saveFilePlan(plan, async () => {});
  assert.equal((await loadSnapshot(f.root)).resolved.agent.build.model, 'fixture/composed');
  assert.match(await readFile(f.file, 'utf8'), /Retain this comment/);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'opencode.jsonc'), 'utf8')), f.native);
});

test('a still-invalid repair is rejected even when the save callback omits candidate validation', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file, 'utf8');
  const snapshot = await loadEditorSnapshot(f.root);
  const plan = planDefinition(snapshot, {
    operation: 'patch',
    registry: 'componentGroups',
    name: 'work',
    path: ['agents'],
    value: ['dormant'],
  });
  await assert.rejects(
    saveFilePlan(plan, async () => {}),
    /dormant.*disabled/,
  );
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('repair supports explicit local deactivation of read-only membership without rewriting the definition', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file, 'utf8');
  await chmod(f.file, 0o444);
  const snapshot = await loadEditorSnapshot(f.root);
  assert.throws(
    () =>
      planDefinition(snapshot, {
        operation: 'patch',
        registry: 'componentGroups',
        name: 'work',
        path: ['agents'],
        value: ['build'],
      }),
    /Read-only/,
  );
  const plan = planScope(snapshot, 'local', { operation: 'selection', profiles: [] });
  await saveFilePlan(plan, async () => {});
  assert.deepEqual((await loadSnapshot(f.root)).sources.activeProfiles, []);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('repair captures freshness and does not swallow unrelated source or runtime failures', async (t) => {
  const f = await fixture(t);
  const snapshot = await loadEditorSnapshot(f.root);
  const plan = planScope(snapshot, 'local', { operation: 'selection', profiles: [] });
  await writeFile(f.file, (await readFile(f.file, 'utf8')) + '\n// Concurrent edit');
  await assert.rejects(
    saveFilePlan(plan, async () => {}),
    /changed/,
  );
  await writeFile(f.file, '{"activeProfiles":');
  await assert.rejects(loadEditorSnapshot(f.root), /JSONC|syntax/);
  await writeFile(
    f.file,
    JSON.stringify({
      componentGroups: { work: { agents: ['build'], configuration: { modelRef: 'preset:missing' } } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  await assert.rejects(loadEditorSnapshot(f.root), /preset|missing/);
});

test('initial membership failure publishes an exact native repair baseline and rethrows without partial apply', async (t) => {
  const f = await fixture(t);
  const options = { configFile: f.file };
  const original = [[packageName, options]] satisfies NonNullable<Config['plugin']>;
  const config: Config = { ...structuredClone(f.native), plugin: original };
  const hooks = await server.server({ directory: f.root, worktree: f.root } as PluginInput, options);
  await assert.rejects(hooks.config!(config), /removed.*unavailable/);
  assert.deepEqual(readRuntimeBaseline(config, { root: f.root, directory: f.root }), {
    model: 'fixture/native',
    agent: f.native.agent,
  });
  assert.deepEqual(config.agent, f.native.agent);
  assert.equal(config.model, 'fixture/native');
  assert.deepEqual(original, [[packageName, { configFile: f.file }]], 'authored registration stays untouched');
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'opencode.jsonc'), 'utf8')), f.native);
});

test('several repairs in one source accumulate and preserve the draft until every active group resolves', async (t) => {
  const f = await fixture(t);
  const value = parseCompositionDocument(await readFile(f.file, 'utf8'), f.file);
  assert.ok(value.componentGroups !== undefined && value.profiles?.work.layers !== undefined);
  value.componentGroups.other = { agents: ['also-removed'] };
  value.profiles.work.layers.push({ componentGroup: 'other' });
  await writeFile(f.file, JSON.stringify(value));
  const snapshot = await loadEditorSnapshot(f.root);
  const members = [{ group: 'work', kind: 'agents' as const, members: ['build'] }];
  await assert.rejects(previewFilePlan(planMembershipRepair(snapshot, { members })), /also-removed/);
  members.push({ group: 'other', kind: 'agents', members: ['plan'] });
  const plan = planMembershipRepair(snapshot, { members });
  assert.equal(plan.edits.length, 1);
  await saveFilePlan(plan, async () => {});
  const current = await loadSnapshot(f.root);
  assert.deepEqual(current.sources.registry.componentGroups?.work.agents, ['build']);
  assert.deepEqual(current.sources.registry.componentGroups.other.agents, ['plan']);
});

test('a missing native frontmatter group can be defined in the chosen scope without editing native fields', async (t) => {
  const f = await fixture(t);
  f.native.agent!.worker = { options: { groups: ['missing-team'] }, model: 'fixture/pinned' };
  const nativeText = JSON.stringify(f.native);
  await writeFile(join(f.root, 'opencode.jsonc'), nativeText);
  const snapshot = await loadEditorSnapshot(f.root);
  const plan = planMembershipRepair(snapshot, {
    members: [{ group: 'work', kind: 'agents', members: ['build'] }],
    groups: [{ name: 'missing-team', sourceId: f.file }],
  });
  await saveFilePlan(plan, async () => {});
  assert.deepEqual((await loadSnapshot(f.root)).sources.registry.componentGroups?.['missing-team'], {});
  assert.equal(await readFile(join(f.root, 'opencode.jsonc'), 'utf8'), nativeText);
});

test('membership failure on a reused config preserves last applied fields and the original native repair baseline', async (t) => {
  const f = await fixture(t);
  const value = parseCompositionDocument(await readFile(f.file, 'utf8'), f.file);
  assert.ok(value.componentGroups !== undefined && value.profiles?.work.layers !== undefined);
  value.componentGroups.work.agents = ['build'];
  value.defaults = { model: 'fixture/composed' };
  await writeFile(f.file, JSON.stringify(value));
  const options = { configFile: f.file };
  const config: Config = { ...structuredClone(f.native), plugin: [[packageName, options]] };
  const hooks = await server.server({ directory: f.root, worktree: f.root } as PluginInput, options);
  await hooks.config!(config);
  const applied = structuredClone({ ...config, plugin: undefined });
  value.componentGroups.work.agents.push('missing-later');
  await writeFile(f.file, JSON.stringify(value));
  await assert.rejects(hooks.config!(config), /missing-later/);
  assert.deepEqual({ ...config, plugin: undefined }, applied);
  assert.deepEqual(readRuntimeBaseline(config, { root: f.root, directory: f.root }), {
    model: 'fixture/native',
    agent: f.native.agent,
  });
});

test('repair observes newly reachable prompt inputs and native agents across asynchronous validation', async (t) => {
  const f = await fixture(t);
  const value = parseCompositionDocument(await readFile(f.file, 'utf8'), f.file);
  value.sourceDirectories = { snippets: '.' };
  value.components = { agents: { helper: { prompt: 'Authored base' } } };
  value.defaults = { agents: { prompt: { append: ['{{include:@snippets/guide.md}}'] } } };
  await writeFile(f.file, JSON.stringify(value));
  const snippet = join(f.root, 'guide.md');
  await writeFile(snippet, 'Original guidance');
  const createPlan = async () =>
    planMembershipRepair(await loadEditorSnapshot(f.root), {
      members: [{ group: 'work', kind: 'agents', members: ['helper'] }],
    });
  const before = await readFile(f.file, 'utf8');
  await assert.rejects(
    saveFilePlan(await createPlan(), async () => {
      await writeFile(snippet, 'Concurrent guidance');
    }),
    /changed/,
  );
  assert.equal(await readFile(f.file, 'utf8'), before);
  await assert.rejects(
    saveFilePlan(await createPlan(), async () => {
      await mkdir(join(f.root, 'agents'));
      await writeFile(join(f.root, 'agents/late.md'), '---\ndescription: Added during validation\n---\nRetain');
    }),
    /agent list changed|source list changed/,
  );
  assert.equal(await readFile(f.file, 'utf8'), before);
});
