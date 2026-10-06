import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageName } from '../src/config-composer/package-name.ts';
import { loadSnapshot, saveFilePlan } from '../src/config-composer/storage.ts';
import { planDefinition, previewDefinition } from '../src/config-composer/composition/authoring.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-authoring-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agents'));
  await mkdir(join(root, '.opencode'));
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [packageName], agent: { worker: { groups: ['work'] } } }),
  );
  await writeFile(join(root, 'agents/helper.md'), '---\ngroups: [work] # Preserve this comment\n---\nUnchanged body.');
  await writeFile(
    join(root, 'definitions.jsonc'),
    `{
    "configurationPresets": { "balanced": { /* Preserve preset comment */ "model": "fixture/a" } },
    "componentGroups": { "work": { "agents": ["build"], "configuration": { "modelRef": "preset:balanced" } } },
    "profiles": { "work": { "layers": [{"componentGroup":"work"}] } }
  }`,
  );
  await writeFile(join(root, 'config-composer.jsonc'), '{"imports":["./definitions.jsonc"],"activeProfiles":["work"]}');
  return root;
}

async function save(plan: ReturnType<typeof planDefinition>) {
  await saveFilePlan(plan, async () => {
    await previewDefinition(plan);
  });
}

test('registry creation uses an explicit writable source and keeps profile activation unchanged', async (t) => {
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  const sourceId = join(root, 'definitions.jsonc');
  const plan = planDefinition(snapshot, { operation: 'create', registry: 'profiles', name: 'review', sourceId });
  assert.deepEqual(
    plan.edits.map((edit) => edit.file.path),
    [sourceId],
  );
  await save(plan);
  const current = await loadSnapshot(root);
  assert.deepEqual(current.sources.activeProfiles, ['work']);
  assert.deepEqual(current.sources.registry.profiles?.review, { layers: [] });
  assert.throws(
    () => planDefinition(current, { operation: 'create', registry: 'profiles', name: 'review', sourceId }),
    /already exists/,
  );
});

test('preset rename preserves definition comments and rewrites canonical references', async (t) => {
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  await save(
    planDefinition(snapshot, {
      operation: 'rename',
      registry: 'configurationPresets',
      name: 'balanced',
      nextName: 'fast',
    }),
  );
  const current = await loadSnapshot(root);
  assert.equal(current.sources.registry.configurationPresets?.balanced, undefined);
  assert.equal(current.sources.registry.componentGroups?.work.configuration?.modelRef, 'preset:fast');
  assert.equal(current.resolved.agent.build.model, 'fixture/a');
  assert.match(await readFile(join(root, 'definitions.jsonc'), 'utf8'), /Preserve preset comment/);
});

test('group rename rewrites canonical and native JSON/frontmatter memberships transactionally', async (t) => {
  const root = await fixture(t);
  await save(
    planDefinition(await loadSnapshot(root), {
      operation: 'rename',
      registry: 'componentGroups',
      name: 'work',
      nextName: 'coding',
    }),
  );
  const current = await loadSnapshot(root);
  assert.equal(current.sources.registry.profiles?.work.layers?.[0].componentGroup, 'coding');
  assert.deepEqual(current.nativeAgents.worker.groups, ['coding']);
  assert.deepEqual(current.nativeAgents.helper.groups, ['coding']);
  assert.match(await readFile(join(root, 'agents/helper.md'), 'utf8'), /Preserve this comment/);
  assert.ok((await readFile(join(root, 'agents/helper.md'), 'utf8')).endsWith('Unchanged body.'));
});

test('profile rename updates selection and ancestry without changing profile order', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, '.opencode/config-composer.local.jsonc'),
    '{"profiles":{"child":{"extends":"work"}},"activeProfiles":["child","work"]}',
  );
  await save(
    planDefinition(await loadSnapshot(root), {
      operation: 'rename',
      registry: 'profiles',
      name: 'work',
      nextName: 'coding',
    }),
  );
  const current = await loadSnapshot(root);
  assert.deepEqual(current.sources.activeProfiles, ['child', 'coding']);
  assert.equal(current.sources.registry.profiles?.child.extends, 'coding');
});

test('referenced deletion and read-only rename dependencies fail before any write', async (t) => {
  const root = await fixture(t);
  let snapshot = await loadSnapshot(root);
  assert.throws(
    () => planDefinition(snapshot, { operation: 'delete', registry: 'configurationPresets', name: 'balanced' }),
    /referenced/,
  );
  await chmod(join(root, 'agents/helper.md'), 0o444);
  snapshot = await loadSnapshot(root);
  const before = await readFile(join(root, 'definitions.jsonc'), 'utf8');
  assert.throws(
    () =>
      planDefinition(snapshot, { operation: 'rename', registry: 'componentGroups', name: 'work', nextName: 'coding' }),
    /Read-only/,
  );
  assert.equal(await readFile(join(root, 'definitions.jsonc'), 'utf8'), before);
});

test('authoring validates inactive profile references and rejects stale source writes', async (t) => {
  const root = await fixture(t);
  const sourceId = join(root, 'definitions.jsonc');
  await save(
    planDefinition(await loadSnapshot(root), { operation: 'create', registry: 'profiles', name: 'review', sourceId }),
  );
  const snapshot = await loadSnapshot(root);
  const invalid = planDefinition(snapshot, {
    operation: 'patch',
    registry: 'profiles',
    name: 'review',
    path: ['extends'],
    value: 'missing',
  });
  await assert.rejects(previewDefinition(invalid), /Unknown profile/);
  const valid = planDefinition(snapshot, {
    operation: 'patch',
    registry: 'profiles',
    name: 'review',
    path: ['extends'],
    value: 'work',
  });
  await writeFile(sourceId, (await readFile(sourceId, 'utf8')) + '\n// Concurrent edit');
  await assert.rejects(save(valid), /Settings changed/);
  assert.equal((await loadSnapshot(root)).sources.registry.profiles?.review.extends, undefined);
});

test('rename touches schema references and preserves lookalike provider option keys', async (t) => {
  const root = await fixture(t);
  const sourceId = join(root, 'definitions.jsonc');
  const options = {
    modelRef: 'preset:balanced',
    componentGroup: 'work',
    extends: 'work',
    componentGroups: ['work'],
    activeProfiles: ['work'],
  };
  const patch = planDefinition(await loadSnapshot(root), {
    operation: 'patch',
    registry: 'configurationPresets',
    name: 'balanced',
    path: ['parameters', 'options'],
    value: options,
  });
  await save(patch);
  for (const [registry, name, nextName] of [
    ['configurationPresets', 'balanced', 'fast'],
    ['componentGroups', 'work', 'coding'],
    ['profiles', 'work', 'daily'],
  ] as const) {
    await save(planDefinition(await loadSnapshot(root), { operation: 'rename', registry, name, nextName }));
  }
  const current = await loadSnapshot(root);
  assert.deepEqual(current.sources.registry.configurationPresets?.fast.parameters?.options, options);
  assert.match(await readFile(sourceId, 'utf8'), /Preserve preset comment/);
});

test('group rename retains memberships in disabled component definitions', async (t) => {
  const root = await fixture(t);
  const source = join(root, 'config-composer.jsonc');
  await writeFile(join(root, 'disabled.md'), '---\ngroups: [work]\n---\nDisabled component body');
  await writeFile(
    source,
    JSON.stringify({
      imports: ['./definitions.jsonc'],
      components: { agents: { disabled: { file: './disabled.md', disable: true } } },
      activeProfiles: ['work'],
    }),
  );
  await save(
    planDefinition(await loadSnapshot(root), {
      operation: 'rename',
      registry: 'componentGroups',
      name: 'work',
      nextName: 'coding',
    }),
  );
  assert.match(await readFile(join(root, 'disabled.md'), 'utf8'), /coding/);
  assert.doesNotMatch(await readFile(join(root, 'disabled.md'), 'utf8'), /work/);
});

test('unused definitions can be created and deleted in every registry without changing activation', async (t) => {
  const root = await fixture(t);
  for (const registry of ['componentGroups', 'configurationPresets', 'profiles'] as const) {
    await save(
      planDefinition(await loadSnapshot(root), {
        operation: 'create',
        registry,
        name: 'unused',
        value: registry === 'configurationPresets' ? { model: 'fixture/a' } : undefined,
        sourceId: join(root, 'definitions.jsonc'),
      }),
    );
    await save(planDefinition(await loadSnapshot(root), { operation: 'delete', registry, name: 'unused' }));
    const current = await loadSnapshot(root);
    assert.equal(current.sources.registry[registry]?.unused, undefined);
    assert.deepEqual(current.sources.activeProfiles, ['work']);
  }
});

test('mixed bundle membership patches retain configuration and reusable prompts while activating commands', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      imports: ['./definitions.jsonc'],
      components: {
        commands: { check: { template: 'Check this' } },
        prompts: { guidance: { text: 'Extra guidance' } },
      },
      activeProfiles: ['work'],
    }),
  );
  for (const [kind, member] of [
    ['commands', 'check'],
    ['prompts', 'guidance'],
  ] as const) {
    await save(
      planDefinition(await loadSnapshot(root), {
        operation: 'patch',
        registry: 'componentGroups',
        name: 'work',
        path: [kind],
        value: [member],
      }),
    );
  }
  const current = await loadSnapshot(root);
  assert.equal(current.sources.registry.componentGroups?.work.configuration?.modelRef, 'preset:balanced');
  assert.equal(current.resolved.commands.check.template, 'Check this');
  assert.deepEqual(current.sources.registry.componentGroups.work.prompts, ['guidance']);
  assert.deepEqual(current.sources.registry.components?.prompts?.guidance, { text: 'Extra guidance' });
});
