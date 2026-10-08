import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCompositionDocument as parse } from '../src/config-composer/composition/document.ts';
import { loadSnapshot, planChange, previewFilePlan, saveFilePlan } from '../src/config-composer/storage.ts';
import { planDefinition } from '../src/config-composer/composition/authoring.ts';
import { packageName } from '../src/config-composer/package-name.ts';

async function fixture(t: TestContext, value: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'composer-binding-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName], model: 'fixture/base' }));
  const file = join(root, 'config-composer.jsonc');
  await writeFile(file, '// preserve this document\n' + JSON.stringify(value));
  return { root, file, snapshot: await loadSnapshot(root) };
}

for (const target of ['preset', 'group', 'agent'] as const) {
  test(`the ${target} model editor clears stale parameters and preserves unrelated settings`, async (t) => {
    const configuration = {
      model: 'fixture/a',
      variant: 'old',
      parameters: { temperature: 0.2 },
      permissions: [{ tool: 'bash', pattern: '*', action: 'ask' }],
    };
    const f = await fixture(t, {
      configurationPresets: { preset: configuration, unrelated: { model: 'fixture/a', parameters: { topP: 0.4 } } },
      componentGroups: { group: { agents: ['worker'], configuration } },
      components: { agents: { worker: { prompt: 'Keep worker', configuration } } },
      profiles: { work: { layers: [{ componentGroup: 'group' }] } },
      activeProfiles: ['work'],
    });
    const plan =
      target === 'preset'
        ? planChange(f.snapshot, { kind: 'preset', name: 'preset', choice: { model: 'fixture/b', variant: 'new' } })
        : target === 'group'
          ? planChange(f.snapshot, { kind: 'group', name: 'group', choice: { model: 'fixture/b', variant: 'new' } })
          : planChange(f.snapshot, {
              kind: 'override',
              agent: 'worker',
              choice: { model: 'fixture/b', variant: 'new' },
            });
    const value = parse(plan.edits.find((edit) => edit.file.path === f.file)!.text);
    const actual =
      target === 'preset'
        ? value.configurationPresets!.preset
        : target === 'group'
          ? value.componentGroups!.group.configuration
          : value.components!.agents!.worker.configuration!;
    assert.ok(actual !== undefined);
    assert.equal(actual.parameters, undefined);
    assert.equal(actual.variant, 'new');
    assert.deepEqual(actual.permissions, configuration.permissions);
    assert.equal(value.components!.agents!.worker.prompt, 'Keep worker');
    assert.deepEqual(value.configurationPresets!.unrelated.parameters, { topP: 0.4 });
    assert.match(plan.edits.find((edit) => edit.file.path === f.file)!.text, /preserve this document/);
    await previewFilePlan(plan);
  });
}

test('changing a same-model reference resets the edited group and reveals destination values', async (t) => {
  const f = await fixture(t, {
    configurationPresets: {
      first: { model: 'fixture/a' },
      second: { model: 'fixture/a', variant: 'destination', parameters: { topP: 0.7 } },
    },
    componentGroups: {
      work: {
        agents: ['build'],
        configuration: { modelRef: 'preset:first', variant: 'old', parameters: { temperature: 0.2 } },
      },
    },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  const plan = planChange(f.snapshot, { kind: 'group', name: 'work', choice: { modelRef: 'preset:second' } });
  const next = await previewFilePlan(plan);
  assert.equal(next.resolved.choices.build.parameters?.temperature, undefined);
  assert.equal(next.resolved.choices.build.parameters?.topP, 0.7);
  assert.equal(next.resolved.choices.build.variant, 'destination');
});

test('preset edits reset active and inactive transitive dependents atomically', async (t) => {
  const f = await fixture(t, {
    configurationPresets: {
      parent: { model: 'fixture/a', variant: 'old', parameters: { temperature: 0.1 } },
      child: { modelRef: 'preset:parent', parameters: { topP: 0.2 } },
    },
    componentGroups: {
      work: { agents: ['build'], configuration: { modelRef: 'preset:child', variant: 'old', parameters: { topK: 3 } } },
    },
    profiles: {
      active: { layers: [{ componentGroup: 'work' }] },
      inactive: {
        overrides: {
          agents: {
            build: { modelRef: 'preset:parent', parameters: { maxOutputTokens: 12 }, prompt: { append: ['Keep'] } },
          },
        },
      },
    },
    activeProfiles: ['active'],
  });
  const plan = planChange(f.snapshot, { kind: 'preset', name: 'parent', choice: { model: 'fixture/b' } });
  const value = parse(plan.edits.find((edit) => edit.file.path === f.file)!.text);
  assert.equal(value.configurationPresets!.parent.parameters, undefined);
  assert.equal(value.configurationPresets!.child.parameters, undefined);
  assert.equal(value.componentGroups!.work.configuration!.parameters, undefined);
  assert.equal(value.componentGroups!.work.configuration!.variant, undefined);
  assert.equal(value.profiles!.inactive.overrides!.agents!.build.parameters, undefined);
  assert.deepEqual(value.profiles!.inactive.overrides!.agents!.build.prompt, { append: ['Keep'] });
  await saveFilePlan(plan, async () => {
    await previewFilePlan(plan);
  });
  assert.equal((await loadSnapshot(f.root)).resolved.choices.build.model, 'fixture/b');
});

test('generic model-reference patches reset old fields without changing reusable destinations', async (t) => {
  const f = await fixture(t, {
    configurationPresets: {
      original: { model: 'fixture/a', variant: 'old', parameters: { temperature: 0.2 } },
      destination: { model: 'fixture/a', variant: 'new', parameters: { topP: 0.6 } },
    },
  });
  const plan = planDefinition(f.snapshot, {
    operation: 'patch',
    registry: 'configurationPresets',
    name: 'original',
    path: ['modelRef'],
    value: 'preset:destination',
  });
  const value = parse(plan.edits[0].text);
  assert.deepEqual(value.configurationPresets!.original, { modelRef: 'preset:destination' });
  assert.deepEqual(value.configurationPresets!.destination, {
    model: 'fixture/a',
    variant: 'new',
    parameters: { topP: 0.6 },
  });
  await previewFilePlan(plan);
});

test('unchanged bindings and parameter-only patches retain authored controls', async (t) => {
  const f = await fixture(t, {
    configurationPresets: { preset: { model: 'fixture/a', variant: 'old', parameters: { temperature: 0.2 } } },
  });
  const plan = planChange(f.snapshot, {
    kind: 'preset',
    name: 'preset',
    choice: { model: 'fixture/a', variant: 'new' },
  });
  assert.deepEqual(parse(plan.edits[0].text).configurationPresets!.preset.parameters, { temperature: 0.2 });
  const partial = planDefinition(f.snapshot, {
    operation: 'patch',
    registry: 'configurationPresets',
    name: 'preset',
    path: ['parameters', 'topP'],
    value: 0.7,
  });
  assert.equal(parse(partial.edits[0].text).configurationPresets!.preset.variant, 'old');
  assert.equal(parse(partial.edits[0].text).configurationPresets!.preset.parameters!.temperature, 0.2);
  assert.equal(await readFile(f.file, 'utf8'), f.snapshot.settingsFile.text);
});

test('an affected read-only dependent prevents every write in the proposed reset', async (t) => {
  const f = await fixture(t, {
    configurationPresets: { parent: { model: 'fixture/a', parameters: { temperature: 0.2 } } },
  });
  const imported = join(f.root, 'dependent.jsonc');
  await writeFile(
    imported,
    JSON.stringify({
      profiles: {
        inactive: { overrides: { agents: { build: { modelRef: 'preset:parent', parameters: { topP: 0.4 } } } } },
      },
    }),
  );
  const rootValue = parse(await readFile(f.file, 'utf8'));
  rootValue.imports = ['./dependent.jsonc'];
  await writeFile(f.file, JSON.stringify(rootValue));
  const snapshot = await loadSnapshot(f.root);
  snapshot.files.find((file) => file.path === imported)!.writable = false;
  const original = await Promise.all([f.file, imported].map((file) => readFile(file, 'utf8')));
  assert.throws(
    () => planChange(snapshot, { kind: 'preset', name: 'parent', choice: { model: 'fixture/b' } }),
    /Read-only affected model binding.*dependent.jsonc.*profiles\/inactive/,
  );
  assert.deepEqual(await Promise.all([f.file, imported].map((file) => readFile(file, 'utf8'))), original);
});

test('explicit new configuration values win and omitted binding fields fall back without saving resolved values', async (t) => {
  const f = await fixture(t, {
    defaults: { model: 'fixture/base', agents: { parameters: { topP: 0.8 } } },
    configurationPresets: { destination: { model: 'fixture/b', variant: 'destination', parameters: { topK: 5 } } },
    componentGroups: {
      work: {
        agents: ['build'],
        configuration: { model: 'fixture/a', variant: 'old', parameters: { temperature: 0.2 } },
      },
    },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  const replacement = { modelRef: 'preset:destination', variant: 'explicit', parameters: { temperature: 0.2 } };
  const plan = planDefinition(f.snapshot, {
    operation: 'patch',
    registry: 'componentGroups',
    name: 'work',
    path: ['configuration'],
    value: replacement,
  });
  assert.deepEqual(parse(plan.edits[0].text).componentGroups!.work.configuration, replacement);
  const resolved = (await previewFilePlan(plan)).resolved.choices.build;
  assert.equal(resolved.variant, 'explicit');
  assert.deepEqual(resolved.parameters, { temperature: 0.2, topK: 5 });
  const removed = planChange(f.snapshot, { kind: 'group', name: 'work', choice: {} });
  const fallback = await previewFilePlan(removed);
  assert.deepEqual(parse(removed.edits[0].text).componentGroups!.work.configuration, {});
  assert.equal(fallback.resolved.choices.build.parameters?.temperature, undefined);
  assert.equal(fallback.resolved.choices.build.parameters?.topP, 0.8);
  assert.equal(fallback.resolved.choices.build.variant, undefined);
});

test('same-model reference changes reset scoped agent settings and indirect dependents', async (t) => {
  const f = await fixture(t, {
    configurationPresets: {
      a: { model: 'fixture/a' },
      b: { model: 'fixture/a', parameters: { topP: 0.9 } },
      parent: { modelRef: 'preset:a', parameters: { temperature: 0.2 } },
    },
    componentGroups: { work: { agents: ['build'] } },
    profiles: {
      work: {
        layers: [{ componentGroup: 'work' }],
        overrides: {
          agents: {
            build: { modelRef: 'preset:parent', variant: 'old', parameters: { topK: 4 }, prompt: { append: ['Keep'] } },
          },
        },
      },
    },
    activeProfiles: ['work'],
  });
  const reference = planDefinition(f.snapshot, {
    operation: 'patch',
    registry: 'configurationPresets',
    name: 'parent',
    path: ['modelRef'],
    value: 'preset:b',
  });
  const value = parse(reference.edits[0].text);
  assert.equal(value.configurationPresets!.parent.parameters, undefined);
  assert.equal(value.profiles!.work.overrides!.agents!.build.parameters, undefined);
  assert.equal(value.profiles!.work.overrides!.agents!.build.variant, undefined);
  assert.equal((await previewFilePlan(reference)).resolved.choices.build.parameters?.topP, 0.9);
  const agent = planDefinition(f.snapshot, {
    operation: 'patch',
    registry: 'profiles',
    name: 'work',
    path: ['overrides', 'agents', 'build', 'modelRef'],
    value: 'preset:b',
  });
  const config = parse(agent.edits[0].text).profiles!.work.overrides!.agents!.build;
  assert.deepEqual(config, { modelRef: 'preset:b', prompt: { append: ['Keep'] } });
});

test('masked native defaults and unchanged references retain their own parameters', async (t) => {
  const f = await fixture(t, {
    defaults: { model: 'fixture/mask' },
    configurationPresets: { native: { modelRef: 'opencode:model', parameters: { temperature: 0.2 } } },
    componentGroups: { work: { configuration: { modelRef: 'preset:native', parameters: { topP: 0.4 } } } },
  });
  const plan = planChange(f.snapshot, { kind: 'global', field: 'model', model: 'fixture/other' });
  assert.ok(!plan.edits.some((edit) => edit.file.path === f.file));
  const same = planChange(f.snapshot, {
    kind: 'group',
    name: 'work',
    choice: { modelRef: 'preset:native', variant: 'new' },
  });
  assert.deepEqual(parse(same.edits[0].text).componentGroups!.work.configuration!.parameters, { topP: 0.4 });
});

test('explicit destination parameters are still validated before any write', async (t) => {
  const { validateParameterChoice } = await import('../src/config-composer/composition/parameter-review.ts');
  const { catalogModels } = await import('../src/config-composer/settings.ts');
  const f = await fixture(t, {
    componentGroups: {
      work: { agents: ['build'], configuration: { model: 'fixture/a', parameters: { temperature: 0.2 } } },
    },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  const plan = planDefinition(f.snapshot, {
    operation: 'patch',
    registry: 'componentGroups',
    name: 'work',
    path: ['configuration'],
    value: { model: 'fixture/b', parameters: { temperature: 0.2 } },
  });
  const catalog = catalogModels([{ id: 'fixture', models: { a: {}, b: { capabilities: { temperature: false } } } }]);
  await assert.rejects(
    saveFilePlan(plan, async () => {
      const next = await previewFilePlan(plan);
      validateParameterChoice(next.resolved.choices.build, catalog);
    }),
    /does not support temperature/,
  );
  assert.equal(await readFile(f.file, 'utf8'), f.snapshot.settingsFile.text);
});

test('an unrelated inactive profile model edit does not reset another profile consumers', async (t) => {
  const f = await fixture(t, {
    componentGroups: {
      work: { agents: ['build'], configuration: { modelRef: 'opencode:model', parameters: { temperature: 0.2 } } },
    },
    profiles: {
      a: { layers: [{ componentGroup: 'work' }], overrides: { model: 'fixture/a' } },
      unrelated: { overrides: { model: 'fixture/b' } },
    },
    activeProfiles: ['a'],
  });
  const plan = planDefinition(f.snapshot, {
    operation: 'patch',
    registry: 'profiles',
    name: 'unrelated',
    path: ['overrides', 'model'],
    value: 'fixture/c',
  });
  assert.deepEqual(parse(plan.edits[0].text).componentGroups!.work.configuration!.parameters, { temperature: 0.2 });
});

test('inactive child model edits reset inherited parent agent bindings', async (t) => {
  const f = await fixture(t, {
    profiles: {
      parent: { overrides: { agents: { build: { modelRef: 'opencode:model', parameters: { topP: 0.4 } } } } },
      child: { extends: 'parent', overrides: { model: 'fixture/b' } },
    },
  });
  const plan = planDefinition(f.snapshot, {
    operation: 'patch',
    registry: 'profiles',
    name: 'child',
    path: ['overrides', 'model'],
    value: 'fixture/c',
  });
  assert.equal(parse(plan.edits[0].text).profiles!.parent.overrides!.agents!.build.parameters, undefined);
});

test('a project-native model mask prevents resets after an unrelated global native edit', async (t) => {
  const f = await fixture(t, {
    configurationPresets: { preset: { modelRef: 'opencode:model', parameters: { topP: 0.4 } } },
  });
  const project = { path: join(f.root, 'project/opencode.jsonc'), text: '{"model":"fixture/project"}', mode: 0o600 };
  f.snapshot.nativeLayers.push({ file: project, kind: 'config', project: true });
  f.snapshot.nativeModels.model = 'fixture/project';
  const plan = planChange(f.snapshot, { kind: 'global', field: 'model', model: 'fixture/next' });
  assert.ok(!plan.edits.some((edit) => edit.file.path === f.file));
});

for (const selection of ['availability', 'membership'] as const) {
  test(`inactive ${selection} selection resets affected component bindings`, async (t) => {
    const f = await fixture(t, {
      components: {
        agents: {
          worker: {
            prompt: 'Worker',
            configuration: { modelRef: 'opencode:model', parameters: { temperature: 0.2 } },
          },
        },
      },
      componentGroups: { work: {} },
      profiles: {
        work: {
          ...(selection === 'availability'
            ? { agentAvailability: { worker: true } }
            : { layers: [{ componentGroup: 'work' }] }),
          overrides: { model: 'fixture/a' },
        },
      },
    });
    if (selection === 'membership') {
      f.snapshot.agents.find((agent) => agent.name === 'worker')!.settings.groups = ['work'];
    }
    const plan = planDefinition(f.snapshot, {
      operation: 'patch',
      registry: 'profiles',
      name: 'work',
      path: ['overrides', 'model'],
      value: 'fixture/b',
    });
    assert.equal(parse(plan.edits[0].text).components!.agents!.worker.configuration!.parameters, undefined);
  });
}

for (const dormant of [false, true]) {
  test(`binding discovery tolerates ${dormant ? 'inactive unavailable' : 'explicitly enabled disabled'} memberships`, async (t) => {
    const f = await fixture(t, {
      configurationPresets: { editable: { model: 'fixture/a', parameters: { temperature: 0.2 } } },
      components: { agents: { worker: { prompt: 'Worker' } } },
      componentGroups: { work: { agents: [dormant ? 'missing' : 'worker'] } },
      profiles: { work: { agentAvailability: { worker: true }, layers: [{ componentGroup: 'work' }] } },
      activeProfiles: dormant ? [] : ['work'],
    });
    f.snapshot.agents.find((agent) => agent.name === 'worker')!.settings.disable = true;
    const plan = planChange(f.snapshot, { kind: 'preset', name: 'editable', choice: { model: 'fixture/b' } });
    assert.equal(parse(plan.edits[0].text).configurationPresets!.editable.parameters, undefined);
  });
}

for (const operation of ['small_model', 'extends', 'remove'] as const) {
  test(`profile ${operation} edits reset dependent global bindings`, async (t) => {
    const f = await fixture(t, {
      componentGroups: {
        work: {
          agents: ['build'],
          configuration: {
            modelRef: operation === 'small_model' ? 'opencode:small_model' : 'opencode:model',
            parameters: { temperature: 0.2 },
          },
        },
      },
      profiles: {
        parent: { overrides: { model: 'fixture/parent' } },
        destination: { overrides: { model: 'fixture/b' } },
        work: {
          extends: 'parent',
          layers: [{ componentGroup: 'work' }],
          ...(operation === 'extends' ? {} : { overrides: { model: 'fixture/a', small_model: 'fixture/a' } }),
        },
      },
    });
    const plan = planDefinition(f.snapshot, {
      operation: 'patch',
      registry: 'profiles',
      name: 'work',
      path:
        operation === 'small_model'
          ? ['overrides', 'small_model']
          : [operation === 'extends' ? 'extends' : 'overrides'],
      value: operation === 'small_model' ? 'fixture/b' : operation === 'extends' ? 'destination' : undefined,
    });
    assert.equal(parse(plan.edits[0].text).componentGroups!.work.configuration!.parameters, undefined);
  });
}
