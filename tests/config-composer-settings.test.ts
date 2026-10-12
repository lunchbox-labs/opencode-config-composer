import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type TestContext, test } from 'node:test';
import { configurationDirectory, loadConfiguration, parseConfiguration } from '../src/config-composer/configuration.ts';
import {
  type AgentSettings,
  agentGroups,
  applyDefaults,
  readSettings,
  resolveChoice,
} from '../src/config-composer/settings.ts';

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'config-composer-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('dedicated settings normalize typed groups and reject unsupported namespaces', () => {
  const settings = readSettings({
    agent: {
      groups: { developers: { modelRef: 'preset:balanced' } },
      modelPresets: { balanced: { model: 'fixture/fast', variant: 'high' } },
    },
    command: {},
    skill: {},
  });
  assert.equal(settings.groups.developers.modelRef, 'preset:balanced');
  assert.throws(() => readSettings({ command: { groups: { build: {} } } }), /reserved/);
  assert.throws(() => readSettings({ skill: { groups: { reviewer: {} } } }), /reserved/);
  assert.throws(
    () => readSettings({ agent: { groups: { reviewer: { modelRef: 'preset:absent' } } } }),
    /does not exist/,
  );
});

test('dedicated settings reject misplaced flat fields and malformed entity sections', () => {
  for (const invalid of [
    { groups: { agents: {} } },
    { modelPresets: {} },
    { agent: null },
    { agent: [] },
    { agent: { groups: null } },
    { agent: { modelPresets: [] } },
    { command: null },
    { skill: [] },
  ]) {
    assert.throws(() => readSettings(invalid));
  }
  const defaults = readSettings({ agent: {}, command: {}, skill: {} });
  assert.deepEqual(defaults, {
    groups: {},
    modelPresets: {},
  });
});

test('ordered memberships merge fields and explicit agent models keep their precedence', () => {
  const settings = readSettings({
    agent: {
      groups: {
        base: { modelRef: 'preset:balanced' },
        developers: { model: 'fixture/next' },
        reviewers: { modelRef: 'opencode:small_model', variant: 'low' },
      },
      modelPresets: { balanced: { model: 'fixture/fast', variant: 'high' } },
    },
  });
  const context = { modelPresets: settings.modelPresets, native: { small_model: 'fixture/small' } };
  const agents: Record<string, AgentSettings> = {
    worker: { groups: ['base', 'developers'] },
    reviewer: { options: { groups: ['base', 'reviewers'] }, variant: 'medium' },
    pinned: { groups: ['base'], model: 'fixture/pinned' },
  };
  applyDefaults(agents, settings.groups, context);
  assert.equal(resolveChoice({ groups: ['base', 'developers'] }, settings.groups, context).modelRef, undefined);
  assert.equal(resolveChoice({ groups: ['base', 'developers'] }, settings.groups, context).variant, 'high');
  assert.equal(agents.worker.model, 'fixture/next');
  assert.equal(agents.worker.variant, 'high');
  assert.equal(agents.reviewer.model, 'fixture/small');
  assert.equal(agents.reviewer.variant, 'medium');
  assert.equal(agents.pinned.model, 'fixture/pinned');
  assert.equal('variant' in agents.pinned, false);
  assert.throws(() => agentGroups({ groups: [], agent_group: 'base' }), /agent_group is not supported/);
  assert.throws(() => agentGroups({ options: { agent_group: 'base' } }), /agent_group is not supported/);
  assert.throws(() => agentGroups({ groups: ['base', 'base'] }), /duplicate/);
  assert.throws(() => agentGroups({ options: { groups: 'base' } }), /ordered array/);
  assert.throws(
    () => resolveChoice({ groups: ['missing'] }, settings.groups, context),
    /unknown Config Composer group/,
  );
  assert.throws(
    () => resolveChoice({ agent_group: 'old-team' }, settings.groups, context),
    /agent_group is not supported/,
  );
});

test('loader resolves paths from the dedicated file and rereads external edits without a cache', async (t) => {
  const root = await directory(t);
  const path = join(root, 'config-composer.jsonc');
  await writeFile(path, '// Keep comments.\n{"agent":{"groups":{}},"command":{},"skill":{},}\n');
  const initial = await loadConfiguration({ configFile: 'config-composer.jsonc', reloadToken: 'token' }, root);
  assert.equal(initial.file.path, path);
  assert.match(initial.file.text, /Keep comments/);
  await writeFile(path, '{"model":"fixture/updated"}');
  assert.equal((await loadConfiguration({ configFile: path }, '/unused')).settings.model, 'fixture/updated');
  assert.deepEqual(configurationDirectory({ OPENCODE_CONFIG_DIR: root, XDG_CONFIG_HOME: '/unused' }), root);
  assert.equal(configurationDirectory({ XDG_CONFIG_HOME: root }), join(root, 'opencode'));
  assert.equal(configurationDirectory({ XDG_CONFIG_HOME: 'relative' }), configurationDirectory({}));
  await assert.rejects(loadConfiguration({ configFile: path, groups: {} }, root), /only configFile/);
  await assert.rejects(loadConfiguration({ configFile: 'missing.jsonc' }, root), /Could not read/);
  await symlink(path, join(root, 'linked.jsonc'));
  await assert.rejects(loadConfiguration({ configFile: 'linked.jsonc' }, root), /regular file/);
});

test('JSONC parser rejects duplicate keys at any depth and invalid root objects', () => {
  assert.deepEqual(parseConfiguration('{"agent":{"groups":{},},}'), { agent: { groups: {} } });
  assert.throws(() => parseConfiguration('{"agent":{},"agent":{}}'), /duplicate/);
  assert.throws(
    () => parseConfiguration('{"agent":{"prompts":{"overrides":{"lead":{"append":[],"append":[]}}}}}'),
    /duplicate/,
  );
  assert.throws(() => parseConfiguration('[]'), /invalid/);
  assert.throws(() => parseConfiguration('{'), /invalid/);
});

test('omitted configFile loads the default file and rejects obsolete inline settings', async (t) => {
  const root = await directory(t);
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    JSON.stringify({
      agent: { groups: { workers: { model: 'fixture/default' } } },
    }),
  );
  for (const options of [undefined, {}, { reloadToken: 'changed' }]) {
    const loaded = await loadConfiguration(options, root);
    assert.equal(loaded.file.path, path);
    assert.equal(loaded.settings.groups.workers.model, 'fixture/default');
  }
  for (const obsolete of [{ groups: {} }, { modelPresets: {} }, { configFile: 'custom.jsonc', groups: {} }]) {
    await assert.rejects(loadConfiguration(obsolete, root), /only configFile/);
  }
  await writeFile(join(root, 'custom.jsonc'), '{"agent":{"groups":{"workers":{"model":"fixture/custom"}}}}');
  assert.equal(
    (await loadConfiguration({ configFile: 'custom.jsonc' }, root)).settings.groups.workers.model,
    'fixture/custom',
  );
  await rm(path);
  await assert.rejects(loadConfiguration(undefined, root), /Could not read/);
});
