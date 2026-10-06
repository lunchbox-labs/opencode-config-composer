import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageName } from '../src/config-composer/package-name.ts';
import {
  loadSnapshot,
  planChange,
  plannedChoices,
  previewFilePlan,
  saveFilePlan,
} from '../src/config-composer/storage.ts';
import { planScope } from '../src/config-composer/composition/activation.ts';
import {
  configurationTargets,
  parameterValue,
  planParameter,
} from '../src/config-composer/composition/parameter-authoring.ts';

test('parameter edits use explicit generated destinations and retain bindings, sibling comments, and native files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-parameters-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode'));
  const native = JSON.stringify({
    plugin: [packageName],
    model: 'fixture/native',
    agent: { worker: { model: 'fixture/pinned' } },
  });
  await writeFile(join(root, 'opencode.jsonc'), native);
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    '{"configurationPresets":{"balanced":{"modelRef":"opencode:model","parameters":{"topP":0.9, /* keep */ "options":{"custom":true}}}},"componentGroups":{"work":{"agents":["build"]}},"profiles":{"work":{"layers":[{"componentGroup":"work"},{"configurationPreset":"balanced","target":{"agents":["build"]}}]}},"activeProfiles":["work"]}',
  );
  let snapshot = await loadSnapshot(root);
  let target = configurationTargets(snapshot, path).find(
    (item) => item.path.join('/') === 'configurationPresets/balanced',
  );
  assert.ok(target !== undefined);
  const plan = planParameter(snapshot, target, 'temperature', '0.4');
  assert.equal((await previewFilePlan(plan)).resolved.choices.build.parameters?.temperature, 0.4);
  await saveFilePlan(plan, async () => {
    await previewFilePlan(plan);
  });
  assert.match(await readFile(path, 'utf8'), /keep/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), native);
  snapshot = await loadSnapshot(root);
  target = configurationTargets(snapshot, path).find(
    (item) => item.path.join('/') === 'configurationPresets/balanced',
  )!;
  assert.equal(parameterValue(snapshot, target).temperature, 0.4);
  const reset = planParameter(snapshot, target, 'temperature', '');
  assert.equal((await previewFilePlan(reset)).resolved.choices.build.parameters?.temperature, undefined);
  assert.equal((await previewFilePlan(reset)).resolved.choices.build.parameters?.topP, 0.9);
  for (const [field, value] of [
    ['temperature', 'Infinity'],
    ['topK', '1.2'],
    ['topP', '1.1'],
    ['options', '{"x":1,"x":2}'],
  ] as const) {
    assert.throws(() => planParameter(snapshot, target, field, value), /finite|temperature|duplicate|safe integer/i);
  }
  assert.throws(
    () => planParameter(snapshot, { ...target, path: ['plugin'] }, 'temperature', '0.5'),
    /target|destination/i,
  );
});

test('parameter catalog review rejects known unsupported controls and validates inactive bindings without retaining secrets', async (t) => {
  const { parameterReview } = await import('../src/config-composer/composition/parameter-review.ts');
  const { catalogModels } = await import('../src/config-composer/settings.ts');
  const root = await mkdtemp(join(tmpdir(), 'composer-parameter-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  const sourceId = join(root, 'config-composer.jsonc');
  await writeFile(sourceId, '{"configurationPresets":{"inactive":{"model":"fixture/model"}}}');
  const snapshot = await loadSnapshot(root);
  const target = configurationTargets(snapshot, sourceId).find((item) => item.label === 'Preset: inactive')!;
  const catalog = catalogModels([
    {
      id: 'fixture',
      options: { apiKey: 'never-expose-this' },
      models: {
        model: {
          api: { npm: '@ai-sdk/openai-compatible', key: 'never-expose-this' },
          capabilities: { temperature: false },
          limit: { output: 128 },
          options: { apiKey: 'never-expose-this' },
        },
      },
    },
  ]);
  assert.ok(!JSON.stringify(catalog).includes('never-expose-this'));
  for (const [field, text, message] of [
    ['temperature', '0.5', /does not support/],
    ['topK', '3', /does not support/],
    ['maxOutputTokens', '129', /output limit/],
    ['options', '{"reasoningEffort":false}', /requires reasoningEffort to be a string/],
  ] as const) {
    const preview = await previewFilePlan(planParameter(snapshot, target, field, text));
    assert.throws(() => parameterReview(snapshot, target, preview, catalog), message);
  }
  const preview = await previewFilePlan(planParameter(snapshot, target, 'options', '{"custom":[true,null,1,"text"]}'));
  assert.match(parameterReview(snapshot, target, preview, catalog), /provider-unverified/);
});

test('parameter destinations respect declaring definitions and forbid scoped settings inside imports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-parameter-origins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  const shared = join(root, 'config-composer.jsonc');
  const imported = join(root, 'definitions.jsonc');
  await writeFile(shared, '{"imports":["./definitions.jsonc"]}');
  await writeFile(
    imported,
    '{"componentGroups":{"work":{}},"configurationPresets":{"balanced":{"model":"fixture/model"}},"profiles":{"work":{}}}',
  );
  const snapshot = await loadSnapshot(root);
  const scoped = configurationTargets(snapshot, shared);
  const definitions = configurationTargets(snapshot, imported);
  assert.ok(scoped.some((target) => target.path[0] === 'defaults'));
  assert.ok(!scoped.some((target) => ['componentGroups', 'configurationPresets', 'profiles'].includes(target.path[0])));
  assert.ok(definitions.some((target) => target.label === 'Group: work'));
  assert.ok(!definitions.some((target) => ['defaults', 'overrides'].includes(target.path[0])));
  const group = definitions.find((target) => target.label === 'Group: work')!;
  await previewFilePlan(planParameter(snapshot, group, 'temperature', '0.5'));
});

test('inactive scoped models and reset-revealed preset options use full runtime reference validation', async (t) => {
  const { parameterReview } = await import('../src/config-composer/composition/parameter-review.ts');
  const { catalogModels } = await import('../src/config-composer/settings.ts');
  const root = await mkdtemp(join(tmpdir(), 'composer-parameter-inheritance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    JSON.stringify({
      defaults: { agents: { model: 'fixture/model' } },
      configurationPresets: {
        parent: { model: 'fixture/model', parameters: { options: { reasoningEffort: false } } },
        child: { modelRef: 'preset:parent', parameters: { options: { reasoningEffort: 'medium' } } },
      },
    }),
  );
  const snapshot = await loadSnapshot(root);
  const catalog = catalogModels([
    {
      id: 'fixture',
      models: { model: { api: { npm: '@ai-sdk/openai-compatible' }, capabilities: { temperature: false } } },
    },
  ]);
  const targets = configurationTargets(snapshot, path);
  const defaults = targets.find((target) => target.label === 'Agent defaults')!;
  const child = targets.find((target) => target.label === 'Preset: child')!;
  const scoped = await previewFilePlan(planParameter(snapshot, defaults, 'temperature', '0.5'));
  assert.throws(() => parameterReview(snapshot, defaults, scoped, catalog), /does not support/);
  const reset = await previewFilePlan(planParameter(snapshot, child, 'options', ''));
  assert.throws(() => parameterReview(snapshot, child, reset, catalog), /requires reasoningEffort to be a string/);
});

test('inactive profile references defer model support until activation resolves that profile global', async (t) => {
  const { parameterReview, validateParameterChoice } =
    await import('../src/config-composer/composition/parameter-review.ts');
  const { catalogModels } = await import('../src/config-composer/settings.ts');
  const root = await mkdtemp(join(tmpdir(), 'composer-parameter-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName], model: 'fixture/current' }));
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    JSON.stringify({
      componentGroups: { work: { agents: ['build'] } },
      profiles: {
        inactive: {
          layers: [{ componentGroup: 'work' }],
          overrides: { model: 'fixture/next', agents: { build: { modelRef: 'opencode:model' } } },
        },
      },
    }),
  );
  const catalog = catalogModels([
    {
      id: 'fixture',
      models: {
        current: { capabilities: { temperature: true } },
        next: { capabilities: { temperature: false } },
      },
    },
  ]);
  let snapshot = await loadSnapshot(root);
  const target = configurationTargets(snapshot, path).find(
    (target) => target.label === 'Profile inactive: build override',
  )!;
  const plan = planParameter(snapshot, target, 'temperature', '0.5');
  const preview = await previewFilePlan(plan);
  assert.match(
    parameterReview(snapshot, target, preview, catalog),
    /inactive profile.*checked when the profile is activated/,
  );
  await saveFilePlan(plan, async () => {
    parameterReview(snapshot, target, await previewFilePlan(plan), catalog);
  });
  snapshot = await loadSnapshot(root);
  const original = await readFile(path, 'utf8');
  const activation = planScope(snapshot, 'shared', { operation: 'selection', profiles: ['inactive'] });
  await assert.rejects(
    saveFilePlan(activation, async () => {
      const candidate = await previewFilePlan(activation);
      assert.equal(candidate.resolved.choices.build.model, 'fixture/next');
      validateParameterChoice(candidate.resolved.choices.build, catalog);
    }),
    /fixture\/next does not support temperature/,
  );
  assert.equal(await readFile(path, 'utf8'), original);
});

test('model edits revalidate preserved parameters on inactive presets', async (t) => {
  const { validateParameterChoice } = await import('../src/config-composer/composition/parameter-review.ts');
  const { catalogModels } = await import('../src/config-composer/settings.ts');
  const root = await mkdtemp(join(tmpdir(), 'composer-parameter-rebind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  const path = join(root, 'config-composer.jsonc');
  const original = JSON.stringify({
    configurationPresets: { inactive: { model: 'fixture/current', parameters: { temperature: 0.5 } } },
  });
  await writeFile(path, original);
  const snapshot = await loadSnapshot(root);
  const plan = planChange(snapshot, { kind: 'preset', name: 'inactive', choice: { model: 'fixture/next' } });
  const choices = await plannedChoices(plan);
  assert.ok(choices.some((choice) => choice.model === 'fixture/next' && choice.parameters?.temperature === 0.5));
  const catalog = catalogModels([
    { id: 'fixture', models: { current: {}, next: { capabilities: { temperature: false } } } },
  ]);
  await assert.rejects(
    saveFilePlan(plan, async () => {
      (await plannedChoices(plan)).forEach((choice) => validateParameterChoice(choice, catalog));
    }),
    /fixture\/next does not support temperature/,
  );
  assert.equal(await readFile(path, 'utf8'), original);
});

for (const target of ['preset', 'group', 'component', 'defaults', 'profile'] as const) {
  test(`model edits revalidate inactive transitive ${target} parameters`, async (t) => {
    const { validateParameterChoice } = await import('../src/config-composer/composition/parameter-review.ts');
    const { catalogModels } = await import('../src/config-composer/settings.ts');
    const root = await mkdtemp(join(tmpdir(), 'composer-parameter-transitive-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
    const path = join(root, 'config-composer.jsonc');
    const configuration = { modelRef: 'preset:child', parameters: { temperature: 0.5 } };
    await writeFile(
      path,
      JSON.stringify({
        configurationPresets: {
          parent: { model: 'fixture/current' },
          child: { modelRef: 'preset:parent', ...(target === 'preset' ? { parameters: { temperature: 0.5 } } : {}) },
        },
        componentGroups:
          target === 'group'
            ? { work: { configuration: { modelRef: 'preset:child', parameters: { temperature: 0.5 } } } }
            : {},
        ...(target === 'component' ? { components: { agents: { worker: { prompt: 'Worker', configuration } } } } : {}),
        ...(target === 'defaults' ? { defaults: { agents: configuration } } : {}),
        ...(target === 'profile'
          ? { profiles: { inactive: { overrides: { agents: { build: configuration } } } } }
          : {}),
      }),
    );
    const plan = planChange(await loadSnapshot(root), {
      kind: 'preset',
      name: 'parent',
      choice: { model: 'fixture/next' },
    });
    const catalog = catalogModels([
      { id: 'fixture', models: { current: {}, next: { capabilities: { temperature: false } } } },
    ]);
    const choices = await plannedChoices(plan);
    assert.throws(
      () => choices.forEach((choice) => validateParameterChoice(choice, catalog)),
      /fixture\/next does not support temperature/,
    );
  });
}

test('an unrelated inactive native-slot reference does not block a global model edit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-parameter-unrelated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName], model: 'fixture/current' }));
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      configurationPresets: {
        unrelated: { modelRef: 'opencode:small_model', parameters: { temperature: 0.5 } },
      },
    }),
  );
  const plan = planChange(await loadSnapshot(root), { kind: 'global', field: 'model', model: 'fixture/next' });
  assert.deepEqual(await plannedChoices(plan), [{ model: 'fixture/next' }]);
});

for (const binding of ['concrete', 'masked native'] as const) {
  test(`bulk defaults leave unchanged inactive ${binding} bindings out of validation`, async (t) => {
    const { catalogModels } = await import('../src/config-composer/settings.ts');
    const { validateParameterChoice } = await import('../src/config-composer/composition/parameter-review.ts');
    const root = await mkdtemp(join(tmpdir(), 'composer-parameter-bulk-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName], model: 'fixture/current' }));
    const configuration = {
      ...(binding === 'concrete' ? { model: 'fixture/pinned' } : { modelRef: 'opencode:model' }),
      parameters: { temperature: 0.5 },
    };
    await writeFile(
      join(root, 'config-composer.jsonc'),
      JSON.stringify({
        components: { agents: { worker: { prompt: 'Worker', configuration } } },
        defaults: { model: 'fixture/pinned', agents: configuration },
        profiles: { inactive: { overrides: { agents: { build: configuration } } } },
      }),
    );
    const plan = planChange(await loadSnapshot(root), { kind: 'all', choice: { model: 'fixture/next' } });
    assert.equal(plan.edits.length, 1);
    assert.equal(plan.edits[0].file.path, join(root, 'opencode.jsonc'));
    const choices = await plannedChoices(plan);
    assert.deepEqual(choices, [{ model: 'fixture/next' }]);
    const catalog = catalogModels([
      { id: 'fixture', models: { next: {}, pinned: { capabilities: { temperature: false } } } },
    ]);
    choices.forEach((choice) => validateParameterChoice(choice, catalog));
  });
}
