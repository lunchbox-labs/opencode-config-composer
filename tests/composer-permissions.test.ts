import { resolveLegacy } from '../src/config-composer/composition/legacy.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  type PermissionPolicy,
  composePermissions,
  explainPermission,
  nativePermission,
} from '../src/config-composer/composition/permissions.ts';
import { type AgentSettings, readSettings } from '../src/config-composer/settings.ts';
import server from '../src/config-composer/server.ts';

test('later wildcard allow wins', () => {
  const policy = composePermissions([{ bash: { 'git *': 'deny' } }, { bash: { '*': 'allow' } }]);
  assert.deepEqual(Object.keys(policy.bash), ['git *', '*']);
  assert.equal(explainPermission(policy, 'bash', 'git status').action, 'allow');
});

test('reverse order and exact-key reinsertion preserve last matching rule', () => {
  const policy = composePermissions([{ bash: { '*': 'allow' } }, { bash: { 'git *': 'deny' } }]);
  assert.equal(explainPermission(policy, 'bash', 'git status').action, 'deny');
  const reinserted = composePermissions([
    { bash: { 'git *': 'deny', 'npm *': 'ask', '*': 'deny' } },
    { bash: { 'git *': 'allow' } },
  ]);
  assert.deepEqual(Object.keys(reinserted.bash), ['npm *', '*', 'git *']);
  assert.deepEqual(explainPermission(reinserted, 'bash', 'git'), {
    action: 'allow',
    matched: { permission: 'bash', pattern: 'git *' },
  });
});

test('scalar contributions remain fallbacks beneath later partial maps', () => {
  const first = { bash: { 'git *': 'deny' as const } };
  assert.deepEqual(composePermissions([first, { bash: 'allow' }]), { bash: 'allow' });
  assert.deepEqual(composePermissions([{ bash: 'deny' }, { bash: { 'git *': 'allow' } }]), {
    bash: { '*': 'deny', 'git *': 'allow' },
  });
  const result = composePermissions([first]);
  assert.notEqual(result.bash, first.bash);
  assert.deepEqual(first, { bash: { 'git *': 'deny' } });
});

test('outer wildcard remains later than an earlier rule in a subsequently mentioned tool', () => {
  assert.equal(
    explainPermission(composePermissions([{ bash: 'deny' }, { '*': 'allow' }]), 'bash', 'git').action,
    'allow',
  );
  assert.equal(
    explainPermission(composePermissions([{ '*': 'allow' }, { bash: 'deny' }]), 'bash', 'git').action,
    'deny',
  );
  const policy = composePermissions([{ bash: { 'git *': 'deny' }, '*': 'allow' }, { bash: { 'npm *': 'ask' } }]);
  assert.deepEqual(Object.keys(policy), ['*', 'bash']);
  assert.equal(explainPermission(policy, 'bash', 'git').action, 'allow');
  assert.equal(explainPermission(policy, 'bash', 'npm install').action, 'ask');
  assert.deepEqual(explainPermission({}, 'bash', 'git'), { fallback: 'native' });
});

test('explanation follows native wildcard, path normalization and home expansion', () => {
  const policy = {
    'ba?': { 'a.b': 'deny' as const, 'line*': 'allow' as const },
    read: { '~/file': 'allow' as const, '$HOME/other': 'deny' as const },
  };
  assert.equal(explainPermission(policy, 'bat', 'a.b').action, 'deny');
  assert.equal(explainPermission(policy, 'bat', 'axb').action, undefined);
  assert.equal(explainPermission(policy, 'bat', 'line\nbreak').action, 'allow');
  assert.equal(explainPermission(policy, 'read', join(homedir(), 'file')).action, 'allow');
  assert.equal(explainPermission(policy, 'read', join(homedir(), 'other').replaceAll('/', '\\')).action, 'deny');
});

test('settings accept only valid ordered permission policies at all three locations', () => {
  const permission = { bash: { '*': 'allow' } };
  const settings = readSettings({
    agent: { permission, groups: { base: { permission } }, overrides: { build: { permission } } },
  });
  assert.deepEqual(settings.permission, permission);
  assert.deepEqual(settings.groups.base.permission, permission);
  assert.deepEqual(settings.agentOverrides?.build.permission, permission);
  for (const policy of [
    { '0': 'allow' },
    { bash: { '42': 'deny' } },
    { bash: 'yes' },
    { bash: [] },
    { bash: { '*': false } },
    'allow',
    JSON.parse('{"__proto__":"deny"}') as unknown,
  ]) {
    for (const agent of [
      { permission: policy },
      { groups: { base: { permission: policy } } },
      { overrides: { build: { permission: policy } } },
    ]) {
      assert.throws(() => readSettings({ agent }));
    }
  }
  assert.throws(() => composePermissions([{ '1': 'deny' }]));
});

test('runtime uses native permissions as fallbacks beneath Composer groups and overrides', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config-composer.jsonc');
  const text = JSON.stringify({
    agent: {
      permission: { bash: { '*': 'allow' }, task: { '*': 'allow' } },
      groups: {
        restricted: { permission: { bash: { 'git *': 'deny' } } },
        open: { permission: { bash: { '*': 'allow' } } },
      },
      overrides: { build: { permission: { bash: 'allow' } }, worker: { permission: { bash: { '*': 'allow' } } } },
    },
  });
  await writeFile(path, text);
  const hooks = await server.server({} as PluginInput, { configFile: path });
  const untouched = { bash: 'ask' as const };
  const agents: Record<string, AgentSettings> = {
    worker: { groups: ['restricted'], permission: { bash: 'deny' }, prompt: 'Worker' },
    grouped: { groups: ['restricted', 'open'] },
    pinned: { groups: ['open'], permission: { bash: 'deny' } },
    native: { permission: untouched },
    off: { disable: true, groups: ['missing'] },
  };
  const config = { permission: { bash: { 'git *': 'deny' as const } }, agent: agents };
  await hooks.config!(config);
  assert.equal(explainPermission(config.permission, 'bash', 'git').action, 'allow');
  assert.equal(explainPermission(agents.worker.permission as PermissionPolicy, 'bash', 'git status').action, 'allow');
  assert.equal(explainPermission(agents.worker.permission as PermissionPolicy, 'task', 'worker').action, 'allow');
  assert.equal(explainPermission(agents.pinned.permission as PermissionPolicy, 'bash', 'git').action, 'allow');
  assert.equal(agents.native.permission, untouched);
  assert.equal(agents.build.prompt, undefined);
  assert.equal(agents.off.permission, undefined);
  assert.equal(Object.hasOwn(agents, 'plan'), false);
  const before = JSON.stringify(config);
  await hooks.config!(config);
  assert.equal(JSON.stringify(config), before);
  agents.grouped.groups = [];
  await hooks.config!(config);
  assert.equal(agents.grouped.permission, undefined, 'removed group contributions restore native inheritance');
  assert.equal(await readFile(path, 'utf8'), text);
});

test('reloading an omitted global contribution restores native permissions and retains other composition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-permission-reload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config-composer.jsonc');
  const composition = {
    model: 'composer/main',
    small_model: 'composer/small',
    agent: {
      permission: { bash: 'allow' },
      groups: { worker: { modelRef: 'opencode:model', permission: { read: 'ask' } } },
      prompts: { defaults: { append: ['After'] } },
    },
  };
  await writeFile(path, JSON.stringify(composition));
  const hooks = await server.server({} as PluginInput, { configFile: path });
  const nativePolicy = { bash: 'deny' as const, edit: 'ask' as const };
  const config = {
    model: 'native/main',
    small_model: 'native/small',
    permission: nativePolicy,
    instructions: ['Native instruction'],
    agent: { worker: { groups: ['worker'], prompt: 'Authored' } },
  };
  await hooks.config!(config);
  assert.equal(explainPermission(config.permission, 'bash', 'git status').action, 'allow');
  await writeFile(path, JSON.stringify({ ...composition, agent: { ...composition.agent, permission: undefined } }));
  await hooks.config!(config);
  assert.equal(config.permission, nativePolicy);
  assert.equal(config.model, 'composer/main');
  assert.equal(config.small_model, 'composer/small');
  assert.deepEqual(config.instructions, ['Native instruction']);
  const worker: AgentSettings = config.agent.worker;
  assert.equal(worker.model, 'composer/main');
  assert.equal(worker.prompt, 'Authored\n\nAfter');
  assert.equal(explainPermission(worker.permission as PermissionPolicy, 'bash', 'git status').action, 'deny');
  assert.equal(explainPermission(worker.permission as PermissionPolicy, 'edit', 'file').action, 'ask');
  assert.equal(explainPermission(worker.permission as PermissionPolicy, 'read', 'file').action, 'ask');
  const restored = structuredClone(config);
  await hooks.config!(config);
  assert.deepEqual(config, restored);
});

test('removing global overlays restores native shorthand and absence while retaining external edits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-permission-external-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config-composer.jsonc');
  for (const scenario of [
    { native: 'ask' },
    {},
    { native: 'deny', external: { bash: 'ask' } },
    { native: { bash: 'deny' }, external: undefined },
  ]) {
    await writeFile(path, JSON.stringify({ agent: { permission: { bash: 'allow' } } }));
    const hooks = await server.server({} as PluginInput, { configFile: path });
    const config = (scenario.native === undefined ? {} : { permission: scenario.native }) as unknown as Parameters<
      NonNullable<typeof hooks.config>
    >[0];
    await hooks.config!(config);
    if (Object.hasOwn(scenario, 'external')) {
      if (scenario.external === undefined) {
        delete config.permission;
      } else {
        config.permission = scenario.external as { bash: 'ask' };
      }
    }
    await writeFile(path, '{}');
    await hooks.config!(config);
    const expected = Object.hasOwn(scenario, 'external') ? scenario.external : scenario.native;
    assert.equal(config.permission, expected);
    assert.equal(Object.hasOwn(config, 'permission'), expected !== undefined);
    assert.equal(Object.hasOwn(config, 'agent'), false);
  }
});

test('invalid native policy fails before mutating global or agent configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    JSON.stringify({ agent: { permission: { '*': 'allow' }, groups: { base: { permission: { bash: 'allow' } } } } }),
  );
  const hooks = await server.server({} as PluginInput, { configFile: path });
  const config = {
    permission: { bash: 'deny' as const },
    agent: { worker: { groups: ['base'], permission: { bash: { '0': 'deny' as const } } } },
  };
  const before = structuredClone(config);
  await assert.rejects(hooks.config!(config), /integer/i);
  assert.deepEqual(config, before);
});

test('known scalar-only native permissions reject pattern maps at every Composer layer', async () => {
  const names = ['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop'];
  for (const name of names) {
    const permission = { [name]: { '*': 'allow' } };
    for (const agent of [
      { permission },
      { groups: { base: { permission } } },
      { overrides: { build: { permission } } },
    ]) {
      assert.throws(() => readSettings({ agent }), /requires a scalar/);
    }
    assert.deepEqual(readSettings({ agent: { permission: { [name]: 'allow' } } }).permission, { [name]: 'allow' });
  }
  // Keep the published native shape restrictions in sync with runtime validation.
  const schema = JSON.parse(await readFile(new URL('../schema.json', import.meta.url), 'utf8')) as {
    $defs: { permission: { properties: Record<string, { $ref: string }> }; permissionAction: { enum: string[] } };
  };
  assert.deepEqual(Object.keys(schema.$defs.permission.properties), names);
  for (const name of names) {
    assert.equal(schema.$defs.permission.properties[name].$ref, '#/$defs/permissionAction');
  }
  assert.deepEqual(schema.$defs.permissionAction.enum, ['allow', 'ask', 'deny']);
  assert.doesNotThrow(() => readSettings({ agent: { permission: { custom_tool: { '*': 'allow' } } } }));
});

test('permission provenance follows ordered global, group, native and Composer contributions', () => {
  const value = {
    agent: {
      permission: { bash: { 'git *': 'allow' }, read: 'ask' },
      groups: { base: { permission: { bash: { 'npm *': 'deny' } } } },
      overrides: {
        'team/worker': { permission: { bash: { '*': 'allow' } } },
        build: { permission: { task: 'allow' } },
      },
    },
  };
  const source = {
    id: 'composer',
    path: '/config/composer.jsonc',
    text: JSON.stringify(value),
    fingerprint: 'fixture',
    writable: true,
    value,
  };
  const result = resolveLegacy(source, {
    permission: { bash: { 'git *': 'deny' }, edit: 'deny' },
    agent: {
      'team/worker': { groups: ['base'], permission: { bash: { 'npm *': 'ask' } } },
      untouched: { permission: { bash: 'deny' } },
    },
  });
  const origins = result.provenance;
  assert.equal(origins['/settings/permission/bash/git *'].pointer, '/agent/permission/bash/git *');
  assert.equal(origins['/settings/agentOverrides/team~1worker/permission/bash/*'].sourceId, source.id);
  assert.equal(origins['/permission/bash/git *'].sourceId, source.id);
  assert.equal(origins['/permission/bash/git *'].overwritten[0].operation, 'native');
  assert.equal(origins['/permission/edit'].operation, 'native');
  const base = '/agent/team~1worker/permission';
  assert.equal(origins[`${base}/bash/*`].pointer, '/agent/overrides/team~1worker/permission/bash/*');
  assert.equal(origins[`${base}/bash/npm *`].operation, 'set');
  assert.equal(origins[`${base}/bash/npm *`].sourceId, source.id);
  assert.equal(origins[`${base}/bash/npm *`].overwritten[0].pointer, '/agent/team~1worker/permission/bash/npm *');
  assert.deepEqual(origins[`${base}/bash`].references, [
    '/agent/permission/bash/git *',
    '/agent/groups/base/permission/bash/npm *',
    '/agent/overrides/team~1worker/permission/bash/*',
  ]);
  assert.equal(origins[`${base}/bash`].operation, 'merge');
  assert.equal(origins['/agent/build/permission/task'].sourceId, source.id);
  assert.equal(origins['/agent/untouched/permission/bash'].operation, 'native');
});

test('permission provenance removes replaced descendants and retains their overwrite history', () => {
  const value = {
    agent: { permission: { bash: 'allow' }, groups: { base: { permission: { bash: { 'other-*': 'deny' } } } } },
  };
  const source = {
    id: 'composer',
    path: '/config/composer.jsonc',
    text: JSON.stringify(value),
    fingerprint: 'fixture',
    writable: true,
    value,
  };
  const result = resolveLegacy(source, {
    permission: { bash: { 'git *': 'deny' } },
    agent: { worker: { groups: ['base'] }, off: { disable: true, groups: ['missing'] } },
  });
  assert.equal(result.provenance['/permission/bash/git *'], undefined);
  assert.equal(result.provenance['/permission/bash'].overwritten[0].operation, 'native');
  const block = result.provenance['/agent/worker/permission/bash'];
  assert.equal(block.pointer, '/agent/groups/base/permission/bash');
  assert.equal(block.overwritten[0].pointer, '/agent/permission/bash');
  assert.deepEqual(block.references, ['/agent/permission/bash', '/agent/groups/base/permission/bash/other-*']);
  assert.equal(result.provenance['/agent/worker/permission/bash/git *'], undefined);
  assert.equal(result.provenance['/agent/off/permission'], undefined);
});

test('strict layers preserve earlier group matches and only then use global fallback', () => {
  const policy = composePermissions([
    { skill: { '*': 'deny' }, read: 'ask' },
    { skill: 'allow' },
    { skill: { 'other-*': 'deny' } },
  ]);
  assert.equal(explainPermission(policy, 'skill', 'included-skill').action, 'allow');
  assert.equal(explainPermission(policy, 'skill', 'other-skill').action, 'deny');
  assert.equal(explainPermission(policy, 'read', 'notes.txt').action, 'ask');
  assert.deepEqual(explainPermission(policy, 'bash', 'git status'), { fallback: 'native' });
});

test('interleaved wildcard tool contributions preserve their own order and exact tool exceptions', () => {
  const policy = composePermissions([
    { 'mcp_*': { a: 'deny' }, bash: { 'git *': 'deny' } },
    { '*': 'allow' },
    { 'mcp_*': { b: 'ask' }, bash: { 'npm *': 'ask' } },
  ]);
  assert.equal(explainPermission(policy, 'mcp_future_tool', 'a').action, 'allow');
  assert.equal(explainPermission(policy, 'mcp_future_tool', 'b').action, 'ask');
  assert.equal(explainPermission(policy, 'bash', 'git status').action, 'allow');
  assert.equal(explainPermission(policy, 'bash', 'npm install').action, 'ask');
});

test('scalar-only native keys retain their position between wildcard contributions', () => {
  const policy = composePermissions([
    { 'webfetch*': { a: 'deny' } },
    { webfetch: 'allow' },
    { 'webfetch*': { b: 'ask' } },
  ]);
  assert.equal(policy.webfetch, 'allow');
  assert.equal(explainPermission(policy, 'webfetch', 'a').action, 'allow');
  assert.equal(explainPermission(policy, 'webfetch', 'b').action, 'ask');
  assert.equal(explainPermission(policy, 'webfetch_extra', 'a').action, 'deny');
});

test('compiler never broadens an unsupported repeated question wildcard to a star', () => {
  assert.throws(
    () => composePermissions([{ 'webfetc?': { a: 'deny' } }, { webfetch: 'allow' }, { 'webfetc?': { b: 'deny' } }]),
    /unsupported permission compilation.*webfetc\?/i,
  );
  const policy = composePermissions([{ 'ba?': { a: 'deny' } }, { 'ba?': { b: 'allow' } }]);
  assert.equal(explainPermission(policy, 'bat', 'a').action, 'deny');
  assert.equal(explainPermission(policy, 'bat', 'b').action, 'allow');
});

test('repeated question globs replay intervening rules covering their whole domain', () => {
  for (const middle of ['*', '**', 'b*', '?a?', 'ba*']) {
    const layers: PermissionPolicy[] = [
      { 'ba?': { a: 'deny', retained: 'ask' } },
      { [middle]: { a: 'allow' } },
      { 'ba?': { b: 'ask' } },
      { '*': { c: 'deny' } },
      { 'ba?': { d: 'allow' } },
    ];
    const policy = composePermissions(layers);
    for (const name of ['bat', 'bar', 'ba', 'bath', 'other']) {
      for (const target of ['a', 'b', 'c', 'd', 'retained', 'unknown']) {
        assert.equal(
          explainPermission(policy, name, target).action,
          layers.map((layer) => explainPermission(layer, name, target).action).findLast((value) => value !== undefined),
          JSON.stringify({ middle, name, target }),
        );
      }
    }
  }
  const policy = composePermissions([{ 'ba?': { a: 'deny' } }, { '*': 'allow' }, { 'ba?': { b: 'ask' } }]);
  assert.equal(explainPermission(policy, 'bat', 'a').action, 'allow');
  assert.equal(explainPermission(policy, 'bat', 'b').action, 'ask');
});

test('optional trailing name glob replays universal partial maps without losing its bare-name match', () => {
  const layers: PermissionPolicy[] = [
    { 'skill *': { a: 'deny', retained: 'ask' } },
    { '*': { a: 'allow' } },
    { 'skill *': { b: 'deny' } },
  ];
  const policy = composePermissions(layers);
  for (const name of ['skill', 'skill extra', 'skills', 'skillx', 'other']) {
    for (const target of ['a', 'b', 'retained', 'unknown']) {
      assert.equal(
        explainPermission(policy, name, target).action,
        layers.map((layer) => explainPermission(layer, name, target).action).findLast((value) => value !== undefined),
        JSON.stringify({ name, target }),
      );
    }
  }
});

test('replayed whole-domain rules retain authored provenance', () => {
  const value = {
    agent: {
      groups: {
        first: { permission: { 'ba?': { a: 'deny' } } },
        middle: { permission: { '*': { a: 'allow' } } },
        last: { permission: { 'ba?': { b: 'ask' } } },
      },
    },
  };
  const source = {
    id: 'composer',
    path: '/config/composer.jsonc',
    text: JSON.stringify(value),
    fingerprint: 'fixture',
    writable: true,
    value,
  };
  const result = resolveLegacy(source, { agent: { worker: { groups: ['first', 'middle', 'last'] } } });
  const origin = result.provenance['/agent/worker/permission/ba?/a'];
  assert.equal(origin.pointer, '/agent/groups/middle/permission/*/a');
  assert.equal(origin.overwritten[0]?.pointer, '/agent/groups/first/permission/ba?/a');
});

test('partial-domain overlaps still reject without broadening', () => {
  for (const middle of ['b?t', 'ba', 'ba?x', 'b*t']) {
    const layers: PermissionPolicy[] = [{ 'ba?': { a: 'deny' } }, { [middle]: 'allow' }, { 'ba?': { b: 'ask' } }];
    if (middle === 'ba' || middle === 'ba?x') {
      // Disjoint names are safe and must not acquire the moved block's rules.
      assert.equal(explainPermission(composePermissions(layers), middle, 'a').action, 'allow');
    } else {
      assert.throws(() => composePermissions(layers), /Unsupported permission compilation/);
    }
  }
});

test('compiled policies agree with last matching authored layers across tool and target overlaps', () => {
  const candidates: PermissionPolicy[] = [
    { bash: { 'git *': 'deny' } },
    { '*': { '*': 'allow' } },
    { bash: { 'npm *': 'ask' } },
    { 'mcp_*': { '*': 'deny' } },
    { 'mcp_*': { read: 'allow' } },
    { '**': { read: 'ask' } },
    { webfetch: 'allow' },
    { 'web*': { read: 'deny' } },
    { skill: 'allow' },
    { skill: { 'other-*': 'deny' } },
  ];
  for (const first of candidates) {
    for (const second of candidates) {
      for (const third of candidates) {
        const layers = [first, second, third];
        const policy = composePermissions(layers);
        for (const permission of ['bash', 'mcp_future', 'webfetch', 'skill', 'unknown']) {
          for (const pattern of ['git status', 'npm install', 'read', 'other-skill']) {
            const expected = layers
              .map((layer) => explainPermission(layer, permission, pattern).action)
              .findLast((value) => value !== undefined);
            assert.equal(
              explainPermission(policy, permission, pattern).action,
              expected,
              JSON.stringify({ layers, permission, pattern }),
            );
          }
        }
      }
    }
  }
});

test('scalar-only permission origins retain overwritten native candidates', () => {
  const value = { agent: { permission: { webfetch: 'allow' } } };
  const source = {
    id: 'composer',
    path: '/config/composer.jsonc',
    text: JSON.stringify(value),
    fingerprint: 'fixture',
    writable: true,
    value,
  };
  const result = resolveLegacy(source, { permission: { webfetch: 'deny' } });
  assert.equal(result.provenance['/permission/webfetch'].sourceId, source.id);
  assert.equal(result.provenance['/permission/webfetch'].overwritten[0]?.operation, 'native');
});

test('unsupported agent policy falls back while preserving global policy and delivering deduplicated warnings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-permission-shape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    JSON.stringify({
      agent: {
        permission: { bash: 'allow' },
        groups: {
          earlier: { permission: { 'webfetc?': { a: 'deny' } } },
          middle: { permission: { webfetch: 'allow' }, model: 'fixture/kept' },
          later: { permission: { 'webfetc?': { b: 'deny' } } },
        },
      },
    }),
  );
  const toasts: unknown[] = [];
  const stderr = t.mock.method(console, 'error', () => undefined);
  const input = {
    client: {
      tui: {
        showToast: async (value: unknown) => {
          toasts.push(value);
          return {};
        },
      },
    },
  } as unknown as PluginInput;
  const hooks = await server.server(input, { configFile: path });
  const config = {
    permission: { bash: 'deny' as const },
    agent: { worker: { groups: ['earlier', 'middle', 'later'] } },
  };
  await hooks.config!(config);
  assert.deepEqual(config.permission, { bash: 'allow' });
  assert.deepEqual(config.agent.worker, { groups: ['earlier', 'middle', 'later'], model: 'fixture/kept' });
  assert.equal(toasts.length, 1);
  assert.equal(stderr.mock.callCount(), 1);
  assert.match(JSON.stringify(toasts), /worker.*webfetc\?.*webfetch/);
  assert.ok(JSON.stringify(toasts).includes(path));
  assert.match(JSON.stringify(toasts), /more permissive/);
  await hooks.config!(config);
  assert.equal(toasts.length, 1);
  const deliver = hooks['chat.message']!;
  const messageInput = { sessionID: 'session-one' } as Parameters<typeof deliver>[0];
  const messageOutput = { message: { agent: 'worker' }, parts: [] } as unknown as Parameters<typeof deliver>[1];
  await deliver(messageInput, messageOutput);
  await deliver(messageInput, messageOutput);
  assert.equal(toasts.length, 2, 'active warning is replayed once per session');
  config.agent.worker.groups = [];
  await hooks.config!(config);
  assert.equal(toasts.length, 3);
  assert.match(JSON.stringify(toasts.at(-1)), /resolved/);
  await deliver(messageInput, messageOutput);
  assert.equal(toasts.length, 4);
  assert.match(JSON.stringify(toasts.at(-1)), /resolved for this session/);
});

test('generated wildcard keys retain authored provenance and overwritten candidates', () => {
  const value = {
    agent: {
      groups: {
        first: { permission: { 'mcp_*': { b: 'deny' } } },
        middle: { permission: { '*': 'allow' } },
        last: { permission: { 'mcp_*': { b: 'ask' } } },
      },
    },
  };
  const source = {
    id: 'composer',
    path: '/config/composer.jsonc',
    text: JSON.stringify(value),
    fingerprint: 'fixture',
    writable: true,
    value,
  };
  const result = resolveLegacy(source, { agent: { worker: { groups: ['first', 'middle', 'last'] } } });
  const origin = result.provenance['/agent/worker/permission/mcp_**/b'];
  assert.equal(origin.pointer, '/agent/groups/last/permission/mcp_*/b');
  assert.equal(origin.sourceId, source.id);
  assert.equal(origin.overwritten[0]?.pointer, '/agent/groups/first/permission/mcp_*/b');
});

test('unsupported global contribution preserves native fallback and independent agent policy and model', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-global-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(console, 'error', () => undefined);
  const path = join(root, 'config-composer.jsonc');
  const value = {
    agent: {
      permission: { webfetch: 'allow', 'webfetc?': { b: 'deny' } },
      groups: { good: { permission: { bash: 'allow' }, model: 'fixture/model' } },
    },
  };
  await writeFile(path, JSON.stringify(value));
  const hooks = await server.server({} as PluginInput, { configFile: path });
  const config = {
    permission: { bash: 'deny' as const, 'webfetc?': { a: 'deny' as const } },
    agent: { worker: { groups: ['good'] } },
  };
  const original = config.permission;
  await hooks.config!(config);
  assert.deepEqual(config.permission, { bash: 'deny', 'webfetc?': { a: 'deny' } });
  const agent: AgentSettings = config.agent.worker;
  assert.equal(explainPermission(nativePermission(agent.permission), 'bash', 'anything').action, 'allow');
  assert.equal(agent.model, 'fixture/model');
  const source = { id: 'composer', path, text: JSON.stringify(value), fingerprint: 'fixture', writable: true, value };
  assert.doesNotThrow(() =>
    resolveLegacy(source, { permission: config.permission, agent: { worker: { groups: ['good'] } } }),
  );
  await writeFile(path, JSON.stringify({ agent: { groups: value.agent.groups } }));
  await hooks.config!(config);
  assert.equal(config.permission, original);
  assert.equal(explainPermission(nativePermission(agent.permission), 'bash', 'anything').action, 'allow');
  assert.equal(agent.model, 'fixture/model');
});

test('unsupported global composition retains native permission provenance', () => {
  const value = { agent: { permission: { webfetch: 'allow', 'webfetc?': { b: 'deny' } } } };
  const source = {
    id: 'composer',
    path: '/config/composer.jsonc',
    text: JSON.stringify(value),
    fingerprint: 'fixture',
    writable: true,
    value,
  };
  const native = { permission: { bash: 'ask', 'webfetc?': { a: 'deny' } } };
  const result = resolveLegacy(source, native);
  assert.deepEqual(result.provenance['/permission/bash'], {
    pointer: '/permission/bash',
    layer: 'native',
    operation: 'native',
    references: [],
    overwritten: [],
  });
});

test('unsupported agent composition retains native permission provenance', () => {
  const value = {
    agent: {
      groups: {
        first: { permission: { 'webfetc?': { a: 'deny' } } },
        middle: { permission: { webfetch: 'allow' } },
        last: { permission: { 'webfetc?': { b: 'deny' } } },
      },
    },
  };
  const source = {
    id: 'composer',
    path: '/config/composer.jsonc',
    text: JSON.stringify(value),
    fingerprint: 'fixture',
    writable: true,
    value,
  };
  const result = resolveLegacy(source, {
    agent: { worker: { groups: ['first', 'middle', 'last'], permission: { skill: 'allow' } } },
  });
  assert.deepEqual(result.provenance['/agent/worker/permission/skill'], {
    pointer: '/agent/worker/permission/skill',
    layer: 'native',
    operation: 'native',
    references: [],
    overwritten: [],
  });
});

test('permission warnings escape slash and tilde in native and Composer agent pointers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-pointer-warning-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stderr = t.mock.method(console, 'error', () => undefined);
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    JSON.stringify({
      agent: {
        groups: { first: { permission: { 'webfetc?': { a: 'deny' } } }, middle: { permission: { webfetch: 'allow' } } },
        overrides: { 'team/worker~one': { permission: { 'webfetc?': { b: 'deny' } } } },
      },
    }),
  );
  const hooks = await server.server({} as PluginInput, { configFile: path });
  await hooks.config!({ agent: { 'team/worker~one': { groups: ['first', 'middle'] } } });
  const warning = String(stderr.mock.calls[0]?.arguments[0]);
  assert.ok(warning.includes('native /agent/team~1worker~0one/permission'));
  assert.ok(warning.includes(`${path}#/agent/overrides/team~1worker~0one/permission`));
});
