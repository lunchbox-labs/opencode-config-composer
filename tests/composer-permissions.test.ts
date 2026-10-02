import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { composePermissions, explainPermission } from '../src/config-composer/composition/permissions.ts';
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

test('scalar and map changes replace complete blocks without mutating inputs', () => {
  const first = { bash: { 'git *': 'deny' as const } };
  assert.deepEqual(composePermissions([first, { bash: 'allow' }]), { bash: 'allow' });
  assert.deepEqual(composePermissions([{ bash: 'deny' }, { bash: { 'git *': 'allow' } }]), {
    bash: { 'git *': 'allow' },
  });
  const result = composePermissions([first]);
  assert.notEqual(result.bash, first.bash);
  assert.deepEqual(first, { bash: { 'git *': 'deny' } });
});

test('outer wildcard and retained-block movement follow native block order', () => {
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
  assert.equal(explainPermission(policy, 'bash', 'git').action, 'deny');
  assert.deepEqual(explainPermission({}, 'bash', 'git'), { action: 'ask' });
});

test('explanation follows native wildcard, path normalization and home expansion', () => {
  const policy = {
    'ba?': { 'a.b': 'deny' as const, 'line*': 'allow' as const },
    read: { '~/file': 'allow' as const, '$HOME/other': 'deny' as const },
  };
  assert.equal(explainPermission(policy, 'bat', 'a.b').action, 'deny');
  assert.equal(explainPermission(policy, 'bat', 'axb').action, 'ask');
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

test('runtime overlays globals and groups beneath explicit native and Composer agent permissions', async (t) => {
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
  assert.deepEqual(agents.worker.permission, { task: { '*': 'allow' }, bash: { '*': 'allow' } });
  assert.deepEqual(agents.pinned.permission, { task: { '*': 'allow' }, bash: 'deny' });
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
