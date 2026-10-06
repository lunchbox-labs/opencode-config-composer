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

test('compiler never broadens an unrepresentable repeated question wildcard to a star', () => {
  assert.throws(
    () => composePermissions([{ 'webfetc?': { a: 'deny' } }, { webfetch: 'allow' }, { 'webfetc?': { b: 'deny' } }]),
    /cannot preserve.*webfetc\?/i,
  );
  const policy = composePermissions([{ 'ba?': { a: 'deny' } }, { 'ba?': { b: 'allow' } }]);
  assert.equal(explainPermission(policy, 'bat', 'a').action, 'deny');
  assert.equal(explainPermission(policy, 'bat', 'b').action, 'allow');
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

test('unsupported wildcard interleaving fails atomically rather than broadening permissions', async (t) => {
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
          middle: { permission: { webfetch: 'allow' } },
          later: { permission: { 'webfetc?': { b: 'deny' } } },
        },
      },
    }),
  );
  const hooks = await server.server({} as PluginInput, { configFile: path });
  const config = {
    permission: { bash: 'deny' as const },
    agent: { worker: { groups: ['earlier', 'middle', 'later'] } },
  };
  const before = structuredClone(config);
  await assert.rejects(hooks.config!(config), /cannot preserve/);
  assert.deepEqual(config, before);
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
