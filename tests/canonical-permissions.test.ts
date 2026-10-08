import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config as PluginConfig, PluginInput } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk/v2';
import server from '../src/server.ts';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';
import { resolveProfileRuntime } from '../src/config-composer/composition/runtime.ts';
import { explainPermission, nativePermission } from '../src/config-composer/composition/permissions.ts';
import { readRuntimeBaseline } from '../src/config-composer/composition/runtime-baseline.ts';
import type { CompositionDocument, PermissionRule } from '../src/config-composer/composition/types.ts';

const unsupported: PermissionRule[] = [
  { tool: 'webfetc?', pattern: 'a', action: 'deny' },
  { tool: 'webfetch', action: 'allow' },
  { tool: 'webfetc?', pattern: 'b', action: 'deny' },
  { tool: 'skill', action: 'deny' },
];
const composition = (rules: PermissionRule[]): CompositionDocument => ({
  componentGroups: { work: { agents: ['worker/path'], configuration: { permissions: rules, model: 'fixture/kept' } } },
  profiles: { work: { layers: [{ componentGroup: 'work' }] } },
  activeProfiles: ['work'],
});
async function fixture(t: TestContext, value: CompositionDocument, deferred = false) {
  const root = await mkdtemp(join(tmpdir(), 'composer-canonical-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode'));
  const file = join(root, 'config-composer.jsonc');
  await writeFile(file, JSON.stringify(value));
  const toasts: unknown[] = [];
  const stderr = t.mock.method(console, 'error', () => undefined);
  const hooks = await server.server(
    {
      directory: root,
      worktree: root,
      client: {
        tui: {
          showToast: (value: unknown) => {
            toasts.push(value);
            return deferred ? new Promise(() => undefined) : Promise.resolve({});
          },
        },
      },
    } as unknown as PluginInput,
    { configFile: file },
  );
  const resolve = async (native: Parameters<typeof resolveProfileRuntime>[1] = {}) =>
    resolveProfileRuntime(await loadCompositionSources({ root, baseFile: file, baseExplicit: true }), native);
  return { root, file, hooks, toasts, stderr, resolve };
}

test('canonical global and selected-agent layers preserve last matches and native fallback', async (t) => {
  const value: CompositionDocument = {
    ...composition([{ tool: 'bash', pattern: 'git status', action: 'allow' }]),
    defaults: {
      permissions: [{ tool: 'bash', action: 'ask' }],
      agents: { permissions: [{ tool: 'bash', pattern: 'git *', action: 'deny' }] },
    },
    overrides: { permissions: [{ tool: 'edit', action: 'deny' }] },
  };
  const f = await fixture(t, value);
  const native = {
    permission: { read: 'allow' as const },
    agent: { 'worker/path': { permission: { bash: { 'native *': 'allow' as const } } } },
  };
  const resolved = await f.resolve(native);
  const permission = nativePermission(resolved.agent['worker/path'].permission);
  for (const [command, action] of [
    ['git status', 'allow'],
    ['git log', 'deny'],
    ['native one', 'allow'],
    ['npm test', 'ask'],
  ] as const) {
    assert.equal(explainPermission(permission, 'bash', command).action, action);
  }
  assert.equal(explainPermission(permission, 'read', 'a').action, 'allow');
  assert.equal(explainPermission(nativePermission(resolved.permission), 'edit', 'a').action, 'deny');
  assert.deepEqual(resolved.permissionWarnings, []);
  const at = resolved.provenance['/agent/worker~1path/permission/bash/git status'];
  assert.equal(at.sourceId, f.file);
  assert.equal(at.pointer, '/componentGroups/work/configuration/permissions/0/action');
  assert.equal(resolved.provenance['/agent/worker~1path/permission/bash/native *'].operation, 'native');
});

test('unsupported agent skips every Composer agent rule but keeps native policy and applied global', async (t) => {
  const f = await fixture(t, {
    ...composition(unsupported),
    defaults: { permissions: [{ tool: 'skill', action: 'deny' }] },
  });
  const native = {
    permission: { read: 'allow' as const },
    agent: { 'worker/path': { permission: { skill: 'allow' as const } } },
  };
  const resolved = await f.resolve(native);
  assert.deepEqual(resolved.agent['worker/path'].permission, native.agent['worker/path'].permission);
  assert.equal(resolved.agent['worker/path'].model, 'fixture/kept');
  assert.equal(explainPermission(nativePermission(resolved.permission), 'skill', 'x').action, 'deny');
  assert.equal(resolved.provenance['/agent/worker~1path/permission/skill'].operation, 'native');
  assert.equal(
    resolved.provenance['/agent/worker~1path/permission/skill'].pointer,
    '/agent/worker~1path/permission/skill',
  );
  assert.match(resolved.permissionWarnings[0].message, /All Composer.*agent.*not applied/);
  assert.ok(resolved.permissionWarnings[0].message.includes('native /agent/worker~1path/permission'));
  assert.ok(
    resolved.permissionWarnings[0].message.includes(
      `${f.file}#/componentGroups/work/configuration/permissions/0/action`,
    ),
  );
});

test('unsupported global keeps native origins while independent agent settings compile', async (t) => {
  const f = await fixture(t, {
    ...composition([{ tool: 'skill', action: 'allow' }]),
    defaults: { permissions: unsupported },
  });
  const resolved = await f.resolve({ permission: { read: 'deny' }, agent: { 'worker/path': {} } });
  assert.deepEqual(resolved.permission, { read: 'deny' });
  assert.equal(resolved.provenance['/permission/read'].operation, 'native');
  assert.equal(
    explainPermission(nativePermission(resolved.agent['worker/path'].permission), 'skill', 'x').action,
    'allow',
  );
  assert.equal(resolved.agent['worker/path'].model, 'fixture/kept');
  assert.equal(resolved.permissionWarnings.length, 1);
  assert.equal(resolved.permissionWarnings[0].scope, 'global');
});

test('global rules replay shared and project defaults, ordered profiles, then scoped overrides', async (t) => {
  const f = await fixture(t, {
    defaults: { permissions: [{ tool: 'bash', pattern: 'shared', action: 'allow' }] },
    profiles: {
      a: { overrides: { permissions: [{ tool: 'bash', action: 'deny' }] } },
      b: { overrides: { permissions: [{ tool: 'bash', pattern: 'git *', action: 'allow' }] } },
    },
    activeProfiles: ['a', 'b'],
  });
  await writeFile(
    join(f.root, '.opencode/config-composer.jsonc'),
    JSON.stringify({
      defaults: { permissions: [{ tool: 'read', action: 'deny' }] },
      overrides: { permissions: [{ tool: 'bash', pattern: 'git push', action: 'ask' }] },
    }),
  );
  const result = await f.resolve();
  assert.deepEqual(
    result.globalPermissions.map((item) => item.origin.pointer),
    [
      '/defaults/permissions/0/action',
      '/defaults/permissions/0/action',
      '/profiles/a/overrides/permissions/0/action',
      '/profiles/b/overrides/permissions/0/action',
      '/overrides/permissions/0/action',
    ],
  );
  assert.equal(explainPermission(nativePermission(result.permission), 'bash', 'git status').action, 'allow');
  assert.equal(explainPermission(nativePermission(result.permission), 'bash', 'git push').action, 'ask');
  await writeFile(join(f.root, '.opencode/config-composer.local.jsonc'), '{"activeProfiles":[]}');
  assert.equal(explainPermission(nativePermission((await f.resolve()).permission), 'bash', 'shared').action, 'allow');
});

test('warnings are nonblocking, deduplicated, replayed per session, changed and recovered', async (t) => {
  const value = composition(unsupported);
  const f = await fixture(t, value, true);
  const config: Config = { agent: { 'worker/path': {} } };
  await Promise.race([
    f.hooks.config!(config as PluginConfig),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('config blocked on toast')), 1000);
      timer.unref();
    }),
  ]);
  assert.equal(f.toasts.length, 1);
  assert.equal(f.stderr.mock.callCount(), 1);
  await f.hooks.config!(config as PluginConfig);
  assert.equal(f.toasts.length, 1);
  // Session notifications use a working transport after initialization.
  const g = await fixture(t, value);
  await g.hooks.config!(config as PluginConfig);
  const deliver = g.hooks['chat.message']!;
  const message = { message: { agent: 'worker/path' }, parts: [] } as unknown as Parameters<typeof deliver>[1];
  const session = { sessionID: 'one' } as Parameters<typeof deliver>[0];
  await deliver(session, message);
  await deliver(session, message);
  assert.equal(g.toasts.length, 2);
  await deliver({ ...session, sessionID: 'two' }, message);
  assert.equal(g.toasts.length, 3);
  const changed = structuredClone(value);
  changed.componentGroups!.work.configuration!.permissions = [
    unsupported[0],
    { tool: 'webfet?h', action: 'allow' },
    ...unsupported.slice(2),
  ];
  await writeFile(g.file, JSON.stringify(changed));
  await g.hooks.config!(config as PluginConfig);
  await deliver(session, message);
  assert.equal(g.toasts.length, 5);
  await writeFile(g.file, JSON.stringify(composition([])));
  await g.hooks.config!(config as PluginConfig);
  await deliver(session, message);
  assert.equal(g.toasts.length, 7);
  assert.match(JSON.stringify(g.toasts.at(-1)), /resolved for this session/);
});

test('authored permission objects restore atomically and preserve external replacements', async (t) => {
  const f = await fixture(t, {
    ...composition([{ tool: 'skill', action: 'allow' }]),
    defaults: { permissions: [{ tool: 'bash', action: 'deny' }] },
  });
  const config: Config = { permission: { read: 'allow' }, agent: { 'worker/path': { permission: { skill: 'deny' } } } };
  await f.hooks.config!(config as PluginConfig);
  await f.hooks.config!(config as PluginConfig);
  assert.equal(
    explainPermission(nativePermission(config.agent?.['worker/path']?.permission), 'skill', 'a').action,
    'allow',
  );
  config.agent!['worker/path']!.permission = { skill: { other: 'ask' } };
  await writeFile(
    f.file,
    JSON.stringify({
      componentGroups: { work: { agents: ['worker/path'] } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  await f.hooks.config!(config as PluginConfig);
  assert.deepEqual(config.permission, { read: 'allow' });
  assert.deepEqual(config.agent!['worker/path']!.permission, { skill: { other: 'ask' } });
});

test('native baseline publishes pre-composition global permission and rejects later mutations', async (t) => {
  const f = await fixture(t, { defaults: { permissions: [{ tool: 'skill', action: 'allow' }] } });
  const config: Config = { permission: { skill: 'deny' }, plugin: ['@lunchbox-labs/opencode-config-composer'] };
  await f.hooks.config!(config as PluginConfig);
  const location = { root: f.root, directory: f.root };
  assert.deepEqual(readRuntimeBaseline(config, location).permission, { skill: 'deny' });
  config.permission = { skill: 'ask' };
  assert.throws(() => readRuntimeBaseline(config, location), /permissions changed/);
});

test('unsupported native object lowering warns for only the affected Composer scope', async (t) => {
  for (const rule of [
    { tool: 'question', pattern: 'specific', action: 'deny' },
    { tool: 'read', pattern: '123', action: 'deny' },
  ] as const) {
    const f = await fixture(t, composition([rule]));
    const result = await f.resolve({ agent: { 'worker/path': { permission: { read: 'allow' } } } });
    assert.deepEqual(result.agent['worker/path'].permission, { read: 'allow' });
    assert.equal(result.permissionWarnings.length, 1);
  }
});

test('external permission reordering and in-place global edits are not restored as prior Composer output', async (t) => {
  const f = await fixture(t, {
    ...composition([
      { tool: 's*', action: 'deny' },
      { tool: '*', action: 'allow' },
    ]),
    defaults: { permissions: [{ tool: 'read', action: 'deny' }] },
  });
  const config: Config = { agent: { 'worker/path': {} } };
  await f.hooks.config!(config as PluginConfig);
  const current = config.agent!['worker/path']!.permission;
  assert.ok(typeof current === 'object');
  const reordered = Object.fromEntries(Object.entries(current).reverse());
  config.agent!['worker/path']!.permission = reordered;
  assert.ok(typeof config.permission === 'object');
  config.permission.edit = 'ask';
  await writeFile(f.file, JSON.stringify(composition([])));
  await f.hooks.config!(config as PluginConfig);
  assert.deepEqual(Object.entries(config.agent!['worker/path']!.permission ?? {}), Object.entries(reordered));
  assert.deepEqual(config.permission, { read: 'deny', edit: 'ask' });
});

test('valid native numeric pattern keys trigger scoped compiler fallback while models continue', async (t) => {
  const f = await fixture(t, {
    ...composition([{ tool: 'skill', action: 'allow' }]),
    defaults: { permissions: [{ tool: 'edit', action: 'deny' }] },
  });
  for (const native of [
    { permission: { read: { '123': 'allow' } }, agent: { 'worker/path': {} } },
    { agent: { 'worker/path': { permission: { read: { '123': 'allow' } } } } },
  ]) {
    const result = await f.resolve(native);
    assert.equal(result.agent['worker/path'].model, 'fixture/kept');
    assert.ok(result.permissionWarnings.length > 0);
    assert.deepEqual(result.agent['worker/path'].permission, native.agent['worker/path'].permission);
    assert.equal(
      result.provenance[
        native.permission === undefined ? '/agent/worker~1path/permission/read/123' : '/permission/read/123'
      ].operation,
      'native',
    );
  }
});

test('baseline preserves observable wildcard and pattern order while accepting known-name serialization', async (t) => {
  const f = await fixture(t, {
    defaults: {
      permissions: [
        { tool: 's*', action: 'deny' },
        { tool: '*', action: 'allow' },
        { tool: 'bash', action: 'ask' },
      ],
    },
  });
  const config: Config = {
    agent: { worker: { permission: { skill: { 'first*': 'deny', '*': 'allow' } } } },
    plugin: ['@lunchbox-labs/opencode-config-composer'],
  };
  await f.hooks.config!(config as PluginConfig);
  const location = { root: f.root, directory: f.root };
  assert.ok(typeof config.permission === 'object');
  config.permission = {
    bash: config.permission.bash,
    ...Object.fromEntries(Object.entries(config.permission).filter(([key]) => key !== 'bash')),
  };
  assert.doesNotThrow(() => readRuntimeBaseline(config, location));
  const healthy = structuredClone(config);
  config.permission = Object.fromEntries(Object.entries(config.permission).reverse());
  assert.throws(() => readRuntimeBaseline(config, location), /permissions changed/);
  healthy.agent!.worker!.permission = { skill: { '*': 'allow', 'first*': 'deny' } };
  assert.throws(() => readRuntimeBaseline(healthy, location), /permission order changed/);
});

test('external replacement of a component agent permission does not regain removed file rules', async (t) => {
  const value = {
    ...composition([{ tool: 'bash', action: 'allow' }]),
    components: { agents: { 'worker/path': { file: './worker.md' } } },
  };
  const f = await fixture(t, value);
  await writeFile(join(f.root, 'worker.md'), '---\npermission:\n  skill: deny\n---\nWorker body.\n');
  const config: Config = {};
  await f.hooks.config!(config as PluginConfig);
  config.agent!['worker/path']!.permission = { read: 'ask' };
  await writeFile(f.file, JSON.stringify({ ...value, ...composition([]) }));
  await f.hooks.config!(config as PluginConfig);
  assert.deepEqual(config.agent!['worker/path']!.permission, { read: 'ask' });
});
