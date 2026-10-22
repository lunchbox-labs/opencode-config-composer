import type { AuthoringUi } from '../src/config-composer/tui/authoring.ts';
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

test('mixed bundle membership patches retain configuration while activating commands', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      imports: ['./definitions.jsonc'],
      components: {
        commands: { check: { template: 'Check this' } },
      },
      activeProfiles: ['work'],
    }),
  );
  for (const [kind, member] of [['commands', 'check']] as const) {
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
});

for (const kind of ['env', 'file'] as const) {
  test(`group rename rejects indirect native ${kind} memberships before writing`, async (t) => {
    const root = await fixture(t);
    const variable = 'COMPOSER_AUTHORING_NATIVE_GROUP';
    const previous = process.env[variable];
    process.env[variable] = 'work';
    t.after(() => {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, variable);
      } else {
        process.env[variable] = previous;
      }
    });
    await writeFile(join(root, 'native-group.txt'), 'work');
    const config = join(root, 'opencode.jsonc');
    await writeFile(
      config,
      JSON.stringify({
        plugin: [packageName],
        agent: { worker: { groups: [kind === 'env' ? `{env:${variable}}` : '{file:./native-group.txt}'] } },
      }),
    );
    const before = await readFile(config, 'utf8');
    const definitions = await readFile(join(root, 'definitions.jsonc'), 'utf8');
    const snapshot = await loadSnapshot(root);
    for (const change of [
      { operation: 'rename', registry: 'componentGroups', name: 'work', nextName: 'coding' },
      { operation: 'delete', registry: 'componentGroups', name: 'work' },
    ] as const) {
      assert.throws(
        () => planDefinition(snapshot, change),
        /Indirect native reference.*opencode\.jsonc.*agent\/worker\/groups\/0/s,
      );
    }
    assert.equal(await readFile(config, 'utf8'), before);
    assert.equal(await readFile(join(root, 'definitions.jsonc'), 'utf8'), definitions);
  });
}

test('clearing a parent global override previews the original native baseline and native model references', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      configurationPresets: { native: { modelRef: 'opencode:model' } },
      componentGroups: { work: { agents: ['build'] } },
      profiles: {
        parent: { overrides: { model: 'fixture/composer' } },
        child: {
          extends: 'parent',
          layers: [{ componentGroup: 'work' }, { configurationPreset: 'native', target: { agents: ['build'] } }],
        },
      },
      activeProfiles: ['child'],
    }),
  );
  const snapshot = await loadSnapshot(root, root, { model: 'fixture/native' });
  assert.equal(snapshot.resolved.model, 'fixture/composer');
  assert.equal(snapshot.resolved.agent.build.model, 'fixture/composer');
  const preview = await previewDefinition(
    planDefinition(snapshot, {
      operation: 'patch',
      registry: 'profiles',
      name: 'child',
      path: ['extends'],
      value: undefined,
    }),
  );
  assert.equal(preview.resolved.model, 'fixture/native');
  assert.equal(preview.resolved.agent.build.model, 'fixture/native');
});

test('native command names are selectable and saved through the group membership editor', async (t) => {
  const { openAuthoring } = await import('../src/config-composer/tui/authoring.ts');
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root, root, { commandNames: ['host-command'] });
  interface Action {
    value: string;
    description?: string;
    run: () => void | Promise<void>;
  }
  let actions: Action[] = [];
  const ui = {
    menu: (_title: string, next: Action[] | (() => Action[])) => {
      actions = typeof next === 'function' ? next() : next;
    },
    prompt: () => {},
    back: () => {},
    refresh: () => {},
    propose: async (_snapshot: typeof snapshot, change: Parameters<typeof planDefinition>[1]) => {
      await save(planDefinition(snapshot, change));
    },
    groupModel: () => {},
    presetModel: () => {},
    createPreset: () => {},
  };
  openAuthoring(snapshot, ui);
  for (const value of ['componentGroups', 'work', 'commands']) {
    await actions.find((action) => action.value === value)!.run();
  }
  const command = actions.find((action) => action.value === 'member:host-command');
  assert.ok(command !== undefined, 'host commands appear without a Composer definition');
  assert.doesNotMatch(command.description ?? '', /unavailable/i);
  await command.run();
  await actions.find((action) => action.value === '+save')!.run();
  const current = await loadSnapshot(root, root, { commandNames: ['host-command'] });
  assert.deepEqual(current.sources.registry.componentGroups!.work.commands, ['host-command']);
  assert.deepEqual(current.resolved.commands, {});
});

for (const registry of ['profiles', 'configurationPresets'] as const) {
  test(`Duplicate as copies authored ${registry} from a read-only source without activation`, async (t) => {
    const { openAuthoring } = await import('../src/config-composer/tui/authoring.ts');
    const root = await fixture(t);
    const source = join(root, 'definitions.jsonc');
    const destination = join(root, 'config-composer.jsonc');
    const authored = {
      configurationPresets: {
        balanced: { model: 'fixture/a' },
        original: {
          modelRef: 'preset:balanced',
          variant: 'careful',
          parameters: { temperature: 0.4, options: { custom: ['retain', 2] } },
          permissions: [{ tool: 'bash', action: 'ask' }],
        },
      },
      componentGroups: { work: { agents: ['build'] } },
      profiles: {
        work: { layers: [{ componentGroup: 'work' }] },
        original: {
          extends: 'work',
          layers: [{ configurationPreset: 'original', target: { componentGroups: ['work'], agents: ['build'] } }],
          agentAvailability: { build: true },
          overrides: { agents: { build: { modelRef: 'preset:balanced' } } },
        },
      },
    };
    await writeFile(source, JSON.stringify(authored));
    await chmod(source, 0o444);
    const snapshot = await loadSnapshot(root);
    const before = await readFile(source, 'utf8');
    let actions: Parameters<AuthoringUi['menu']>[1] = [];
    let submit: (value: string) => void | Promise<void> = () => {};
    let plan: ReturnType<typeof planDefinition> | undefined;
    let details = '';
    const ui: AuthoringUi = {
      menu: (_title, next) => {
        actions = next;
      },
      prompt: (_title, _value, confirmed) => {
        submit = confirmed;
      },
      back: () => {},
      refresh: () => {},
      groupModel: () => {},
      presetModel: () => {},
      createPreset: () => {},
      propose: async (snapshot, change, review) => {
        plan = planDefinition(snapshot, change);
        details = review ?? '';
        await previewDefinition(plan);
      },
    };
    const getActions = () => (typeof actions === 'function' ? actions() : actions);
    const getPlan = () => {
      assert.ok(plan !== undefined);
      return plan;
    };
    const choose = async (value: string) => {
      const action = getActions().find((action) => action.value === value);
      assert.ok(action !== undefined, `Missing action ${value}`);
      await action.run();
    };
    openAuthoring(snapshot, ui);
    await choose(registry);
    await choose('original');
    await choose('duplicate');
    assert.equal(plan, undefined, 'opening/cancelling the name prompt does not write');
    assert.throws(() => submit('original'), /already exists/);
    await submit('copy');
    const destinations = getActions();
    assert.ok(!destinations.some((action) => action.value === source));
    await choose(destination);
    const proposed = getPlan();
    assert.match(details, /still depends/i);
    assert.match(details, /preset:balanced/);
    if (registry === 'profiles') {
      assert.match(details, /profile:work/);
      assert.match(details, /group:work/);
      assert.match(details, /preset:original/);
    }
    assert.deepEqual(
      proposed.edits.map((edit) => edit.file.path),
      [destination],
    );
    assert.equal(await readFile(source, 'utf8'), before);
    assert.equal((await loadSnapshot(root)).sources.registry[registry]?.copy, undefined, 'preview does not save');
    await save(proposed);
    const current = await loadSnapshot(root);
    assert.deepEqual(current.sources.registry[registry]?.copy, snapshot.sources.registry[registry]?.original);
    assert.deepEqual(current.sources.registry[registry]?.original, snapshot.sources.registry[registry]?.original);
    assert.deepEqual(current.sources.activeProfiles, snapshot.sources.activeProfiles);
    assert.deepEqual(current.resolved, snapshot.resolved);
    assert.equal(await readFile(source, 'utf8'), before);
    await assert.rejects(save(getPlan()), /Settings changed/);
    const staleSnapshot = await loadSnapshot(root);
    openAuthoring(staleSnapshot, ui);
    await choose(registry);
    await choose('original');
    await choose('duplicate');
    await submit('later');
    await choose(destination);
    await writeFile(destination, (await readFile(destination, 'utf8')) + '\n// concurrent edit');
    await assert.rejects(save(getPlan()), /Settings changed/);
    assert.equal((await loadSnapshot(root)).sources.registry[registry]?.later, undefined);
    await chmod(destination, 0o444);
    openAuthoring(await loadSnapshot(root), ui);
    await choose(registry);
    await choose('original');
    await choose('duplicate');
    assert.throws(() => submit('unwritable'), /No writable composition source/);
    openAuthoring(snapshot, ui);
    await choose('componentGroups');
    await choose('work');
    assert.ok(!getActions().some((action) => action.value === 'duplicate'));
  });
}

for (const registry of ['profiles', 'componentGroups'] as const) {
  test(`${registry} descriptions save in the declaring source without effective changes and reject stale edits`, async (t) => {
    const root = await fixture(t);
    const before = await loadSnapshot(root);
    const plan = planDefinition(before, {
      operation: 'patch',
      registry,
      name: 'work',
      path: ['description'],
      value: 'Review only',
    });
    const preview = await previewDefinition(plan);
    assert.deepEqual(preview.resolved, before.resolved);
    await save(plan);
    const current = await loadSnapshot(root);
    assert.equal(current.sources.registry[registry]?.work.description, 'Review only');
    assert.deepEqual(current.sources.activeProfiles, before.sources.activeProfiles);
    assert.deepEqual(current.resolved, before.resolved);
    assert.match(await readFile(join(root, 'definitions.jsonc'), 'utf8'), /Preserve preset comment/);
    await assert.rejects(
      save(
        planDefinition(before, { operation: 'patch', registry, name: 'work', path: ['description'], value: 'Stale' }),
      ),
      /changed/,
    );
    await save(
      planDefinition(current, { operation: 'patch', registry, name: 'work', path: ['description'], value: undefined }),
    );
    assert.equal((await loadSnapshot(root)).sources.registry[registry]?.work.description, undefined);
  });
}

test('description authoring shows source labels and uses the existing review callback', async (t) => {
  const { openAuthoring } = await import('../src/config-composer/tui/authoring.ts');
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  type Action = Exclude<Parameters<AuthoringUi['menu']>[1], () => unknown>[number];
  let actions: Action[] = [];
  let confirmed: ((value: string) => void | Promise<void>) | undefined;
  let proposed: Parameters<AuthoringUi['propose']>[1] | undefined;
  const ui: AuthoringUi = {
    menu: (_title, next) => {
      actions = typeof next === 'function' ? next() : next;
    },
    prompt: (_title, _value, next) => {
      confirmed = next;
    },
    back: () => {},
    refresh: () => {},
    groupModel: () => {},
    presetModel: () => {},
    createPreset: () => {},
    propose: async (_snapshot, change) => {
      proposed = change;
    },
  };
  for (const registry of ['profiles', 'componentGroups'] as const) {
    openAuthoring(snapshot, ui);
    await actions.find((action) => action.value === registry)!.run();
    assert.ok(actions.find((action) => action.value === 'work')!.description?.includes('definitions.jsonc') === true);
    await actions.find((action) => action.value === 'work')!.run();
    const edit = actions.find((action) => action.value === 'description');
    assert.ok(edit !== undefined);
    await edit.run();
    assert.equal(proposed, undefined, 'opening/cancelling does not propose a write');
    await confirmed!('Review only');
    assert.deepEqual(proposed, {
      operation: 'patch',
      registry,
      name: 'work',
      path: ['description'],
      value: 'Review only',
    });
    proposed = undefined;
  }
});

test('selection and authoring menus show each declaration description without parent inheritance', async (t) => {
  const { openAuthoring } = await import('../src/config-composer/tui/authoring.ts');
  const { openActivation } = await import('../src/config-composer/tui/activation.ts');
  const { compositionRevision } = await import('../src/config-composer/composition/revision.ts');
  const root = await fixture(t);
  const before = await loadSnapshot(root);
  for (const registry of ['profiles', 'componentGroups'] as const) {
    await save(
      planDefinition(await loadSnapshot(root), {
        operation: 'patch',
        registry,
        name: 'work',
        path: ['description'],
        value: `About ${registry}`,
      }),
    );
  }
  await save(
    planDefinition(await loadSnapshot(root), {
      operation: 'create',
      registry: 'profiles',
      name: 'child',
      sourceId: join(root, 'definitions.jsonc'),
      value: { extends: 'work' },
    }),
  );
  const snapshot = await loadSnapshot(root);
  const oldRevision = compositionRevision(before.sources, before.resolved, []);
  const newRevision = compositionRevision(snapshot.sources, snapshot.resolved, []);
  assert.notEqual(newRevision.sources, oldRevision.sources);
  assert.equal(newRevision.effective, oldRevision.effective);
  type Action = Exclude<Parameters<AuthoringUi['menu']>[1], () => unknown>[number];
  let actions: Action[] = [];
  const ui: AuthoringUi = {
    menu: (_title, next) => {
      actions = typeof next === 'function' ? next() : next;
    },
    prompt: () => {},
    back: () => {},
    refresh: () => {},
    groupModel: () => {},
    presetModel: () => {},
    createPreset: () => {},
    propose: async () => {},
  };
  const check = (name: string, description: string) => {
    const actual = actions.find((action) => action.value === name)?.description;
    assert.ok(actual?.includes(description) === true);
    assert.ok(actual.includes('definitions.jsonc'));
  };
  openActivation(snapshot, { menu: ui.menu, back: ui.back, propose: async () => {} });
  await actions.find((action) => action.value === 'ordered')!.run();
  check('0', 'About profiles');
  await actions.find((action) => action.value === '+add')!.run();
  assert.doesNotMatch(actions.find((action) => action.value === 'child')?.description ?? '', /About profiles/);
  openAuthoring(snapshot, ui);
  await actions.find((action) => action.value === 'componentGroups')!.run();
  check('work', 'About componentGroups');
  openAuthoring(snapshot, ui);
  await actions.find((action) => action.value === 'profiles')!.run();
  check('work', 'About profiles');
});

test('searchable definitions preserve registry identity and route to exact declaring targets', async (t) => {
  const { openAuthoring } = await import('../src/config-composer/tui/authoring.ts');
  const { configurationTargets, planParameter } =
    await import('../src/config-composer/composition/parameter-authoring.ts');
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  type Action = Exclude<Parameters<AuthoringUi['menu']>[1], () => unknown>[number];
  let actions: Action[] = [];
  let selected: ReturnType<typeof configurationTargets>[number] | undefined;
  const ui: AuthoringUi = {
    menu: (_title, next) => {
      actions = typeof next === 'function' ? next() : next;
    },
    prompt: () => {},
    back: () => {},
    refresh: () => {},
    groupModel: () => {},
    presetModel: () => {},
    createPreset: () => {},
    propose: async () => {},
    parameters: (target) => {
      selected = target;
    },
    permissions: () => {},
  };
  openAuthoring(snapshot, ui);
  const search = actions.find((action) => action.value === '+find');
  assert.ok(search !== undefined);
  await search.run();
  assert.ok(actions.some((action) => action.value === 'profiles:work'));
  const group = actions.find((action) => action.value === 'componentGroups:work');
  assert.ok(group !== undefined);
  assert.ok(group.description?.includes('definitions.jsonc') === true);
  await group.run();
  await actions.find((action) => action.value === '+parameters')!.run();
  const canonical = configurationTargets(snapshot, join(root, 'definitions.jsonc')).find(
    (target) => target.path[0] === 'componentGroups',
  )!;
  assert.deepEqual(selected, canonical);
  assert.deepEqual(
    planParameter(snapshot, selected, 'temperature', '0.2'),
    planParameter(snapshot, canonical, 'temperature', '0.2'),
  );
});

test('direct settings routes match source-first editors and reject read-only destinations', async (t) => {
  const { openParameters } = await import('../src/config-composer/tui/parameters.ts');
  const { openPermissions } = await import('../src/config-composer/tui/permissions.ts');
  const { configurationTargets } = await import('../src/config-composer/composition/parameter-authoring.ts');
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  const source = join(root, 'definitions.jsonc');
  const target = configurationTargets(snapshot, source).find((item) => item.path[0] === 'componentGroups')!;
  type Action = Exclude<Parameters<AuthoringUi['menu']>[1], () => unknown>[number];
  let actions: Action[] = [];
  let confirmed: ((value: string) => void | Promise<void>) | undefined;
  const parameterCalls: unknown[][] = [];
  const base = {
    menu: (_title: string, next: Action[] | (() => Action[])) => {
      actions = typeof next === 'function' ? next() : next;
    },
    prompt: (_title: string, _value: string, callback: typeof confirmed) => {
      confirmed = callback;
    },
    back: () => {},
    refresh: () => {},
  };
  const parameters = {
    ...base,
    propose: async (...args: Parameters<Parameters<typeof openParameters>[1]['propose']>) => {
      parameterCalls.push(args);
    },
  };
  openParameters(snapshot, parameters);
  await actions.find((action) => action.value === source)!.run();
  await actions.find((action) => action.value === JSON.stringify(target.path))!.run();
  await actions.find((action) => action.value === 'temperature')!.run();
  await confirmed!('0.2');
  openParameters(snapshot, parameters, target);
  await actions.find((action) => action.value === 'temperature')!.run();
  await confirmed!('0.2');
  assert.deepEqual(parameterCalls[0], parameterCalls[1]);
  const permissionCalls: unknown[][] = [];
  const permissions = {
    ...base,
    propose: async (...args: Parameters<Parameters<typeof openPermissions>[1]['propose']>) => {
      permissionCalls.push(args);
    },
    preview: async () => {},
    create: async () => {},
  };
  openPermissions(snapshot, permissions);
  await actions.find((action) => action.value === source)!.run();
  await actions.find((action) => action.value === JSON.stringify(target.path))!.run();
  await actions.find((action) => action.value === '+save')!.run();
  openPermissions(snapshot, permissions, target);
  await actions.find((action) => action.value === '+save')!.run();
  assert.deepEqual(permissionCalls[0], permissionCalls[1]);
  assert.deepEqual((await loadSnapshot(root)).resolved, snapshot.resolved, 'navigation and drafts write nothing');
  snapshot.files.find((file) => file.path === source)!.writable = false;
  assert.throws(() => openParameters(snapshot, parameters, target), /writable/);
  assert.throws(() => openPermissions(snapshot, permissions, target), /writable/);
});
