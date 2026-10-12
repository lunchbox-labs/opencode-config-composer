import assert from 'node:assert/strict';
import type { Config, PluginInput } from '@opencode-ai/plugin';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';
import { resolveProfileRuntime } from '../src/config-composer/composition/runtime.ts';
import type { CompositionDocument } from '../src/config-composer/composition/types.ts';

async function sources(t: TestContext, value: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'composer-reference-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode'));
  const file = join(root, 'composer.jsonc');
  await writeFile(file, JSON.stringify(value));
  return loadCompositionSources({ root, baseFile: file, baseExplicit: true });
}

test('mixed host references skip missing members while preserving valid model and permission composition', async (t) => {
  const input = await sources(t, {
    componentGroups: {
      work: {
        agents: ['build', 'absent-agent', 'disabled-agent'],
        commands: ['host-command', 'absent-command'],
        skills: ['host-skill', 'absent-skill'],
        configuration: { model: 'fixture/valid', permissions: [{ tool: 'skill', pattern: '*', action: 'deny' }] },
      },
    },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  const result = await resolveProfileRuntime(input, {
    agent: { 'disabled-agent': { disable: true } },
    commandNames: ['host-command'],
    componentInventory: { commands: [{ name: 'host-command', source: 'command' }], skills: [{ name: 'host-skill' }] },
  });
  assert.equal(result.agent.build.model, 'fixture/valid');
  assert.equal(result.agent['absent-agent'], undefined);
  assert.deepEqual(result.skillPaths, []);
  assert.deepEqual(result.commands, {});
  assert.deepEqual(result.agent.build.permission, { skill: { '*': 'deny' } });
  assert.deepEqual(
    result.diagnostics.map((item) => [item.kind, item.name, item.status]),
    [
      ['agents', 'absent-agent', 'missing'],
      ['agents', 'disabled-agent', 'disabled'],
      ['commands', 'absent-command', 'missing'],
      ['skills', 'absent-skill', 'missing'],
    ],
  );
  for (const diagnostic of result.diagnostics) {
    assert.equal(diagnostic.group, 'work');
    assert.equal(diagnostic.profile, 'work');
    assert.equal(diagnostic.sourceId, input.documents[0].id);
    assert.match(diagnostic.pointer!, /^\/componentGroups\/work\//);
  }
});

test('unknown inventories stay pending; native skill references require no component file mapping', async (t) => {
  const input = await sources(t, {
    components: { agents: { helper: { prompt: 'Helper', skills: ['native-skill'] } } },
    componentGroups: { work: { agents: ['helper'], skills: ['native-skill'], commands: ['late-command'] } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  const pending = await resolveProfileRuntime(input, {});
  assert.equal(pending.diagnostics.length, 3);
  assert.ok(pending.diagnostics.every((item) => item.status === 'pending'));
  const found = await resolveProfileRuntime(input, {
    componentInventory: { skills: [{ name: 'native-skill' }], commands: [{ name: 'late-command', source: 'mcp' }] },
  });
  assert.deepEqual(found.diagnostics, []);
  assert.equal(found.agent.helper.prompt, 'Helper');
  assert.deepEqual(found.skillPaths, []);
  assert.deepEqual(found.commands, {});
});

test('headless validation uses final commands after initialization, keeps shadowed skills unverified, and deduplicates notices', async (t) => {
  const { default: server } = await import('../src/server.ts');
  const { readRuntimeReferenceDiagnostics } = await import('../src/config-composer/composition/runtime-baseline.ts');
  const { packageName } = await import('../src/config-composer/package-name.ts');
  const input = await sources(t, {
    componentGroups: { work: { skills: ['found', 'shadowed', 'absent'], commands: ['late'] } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  let calls = 0;
  const notices: string[] = [];
  t.mock.method(console, 'error', (message: string) => notices.push(message));
  const hooks = await server.server(
    {
      directory: dirname(input.documents[0].path),
      worktree: dirname(input.documents[0].path),
      client: {
        command: {
          list: async () => {
            calls++;
            return {
              data: [
                { name: 'found', source: 'skill' },
                { name: 'shadowed', source: 'command' },
                { name: 'late', source: 'mcp' },
              ],
            };
          },
        },
      },
    } as unknown as PluginInput,
    { configFile: input.documents[0].path },
  );
  const config = { plugin: [packageName] };
  await hooks.config!(config);
  assert.equal(calls, 0, 'no inventory query can recursively enter bootstrap');
  assert.ok(
    readRuntimeReferenceDiagnostics(config, {
      root: dirname(input.documents[0].path),
      directory: dirname(input.documents[0].path),
    }).diagnostics.every((item) => item.status === 'pending'),
  );
  await hooks['command.execute.before']!({ command: 'late', sessionID: 'session', arguments: '' }, { parts: [] });
  await hooks['command.execute.before']!({ command: 'late', sessionID: 'session', arguments: '' }, { parts: [] });
  assert.equal(calls, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /absent/);
  assert.match(notices[0], /shadowed/);
  assert.match(notices[0], /not verified/i);
  assert.doesNotMatch(notices[0], /skills: found/);
});

test('headless unavailable discovery retries, then resets after corrected configuration', async (t) => {
  const { default: server } = await import('../src/server.ts');
  const input = await sources(t, {
    componentGroups: { work: { skills: ['late'] } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  let calls = 0;
  const notices: string[] = [];
  t.mock.method(console, 'error', (message: string) => notices.push(message));
  const hooks = await server.server(
    {
      directory: dirname(input.documents[0].path),
      worktree: dirname(input.documents[0].path),
      client: {
        command: {
          list: async () => {
            calls++;
            if (calls === 1) {
              throw new Error('Temporarily unavailable');
            }
            return { data: [] };
          },
        },
      },
    } as unknown as PluginInput,
    { configFile: input.documents[0].path },
  );
  const config = {};
  await hooks.config!(config);
  const dispatch = () =>
    hooks['command.execute.before']!({ command: 'init', sessionID: 'session', arguments: '' }, { parts: [] });
  await dispatch();
  assert.match(notices[0], /Not verified/);
  await dispatch();
  assert.match(notices[1], /missing; reference skipped/);
  await dispatch();
  assert.equal(calls, 2);
  assert.equal(notices.length, 2);
  await writeFile(input.documents[0].path, '{}');
  await hooks.config!(config);
  await dispatch();
  assert.equal(calls, 2);
  assert.equal(notices.length, 2);
});

test('preset group targets retain missing and disabled member diagnostics', async (t) => {
  const input = await sources(t, {
    configurationPresets: { fast: { model: 'fixture/fast' } },
    componentGroups: { work: { agents: ['absent', 'disabled'] } },
    profiles: { work: { layers: [{ configurationPreset: 'fast', target: { componentGroups: ['work'] } }] } },
    activeProfiles: ['work'],
  });
  const result = await resolveProfileRuntime(input, { agent: { disabled: { disable: true } } });
  assert.deepEqual(
    result.diagnostics.map((item) => [item.name, item.status, item.group, item.profile]),
    [
      ['absent', 'missing', 'work', 'work'],
      ['disabled', 'disabled', 'work', 'work'],
    ],
  );
});

test('missing targets cannot hide cycles or native command collisions', async (t) => {
  const base = {
    configurationPresets: { loop: { modelRef: 'preset:loop' } },
    componentGroups: { work: { agents: ['absent'], configuration: { modelRef: 'preset:loop' } } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  };
  await assert.rejects(resolveProfileRuntime(await sources(t, base), {}), /cycle/);
  await assert.rejects(
    resolveProfileRuntime(
      await sources(t, {
        ...base,
        configurationPresets: {},
        components: { commands: { duplicate: { template: 'Body', agent: 'absent' } } },
        componentGroups: { work: { commands: ['duplicate'] } },
      }),
      { commandNames: ['duplicate'] },
    ),
    /conflicts with an existing native command/,
  );
});

test('disabled selected Composer agents still validate their authored configuration', async (t) => {
  const input = await sources(t, {
    configurationPresets: { loop: { modelRef: 'preset:loop' } },
    components: { agents: { helper: { prompt: 'Helper', disable: true, configuration: { modelRef: 'preset:loop' } } } },
    componentGroups: { work: { agents: ['helper'] } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  await assert.rejects(resolveProfileRuntime(input, {}), /cycle/);
});

test('inactive preset cycles are rejected before runtime changes', async (t) => {
  const input = await sources(t, {
    configurationPresets: { first: { modelRef: 'preset:second' }, second: { modelRef: 'preset:first' } },
    activeProfiles: [],
  });
  await assert.rejects(resolveProfileRuntime(input, { model: 'fixture/native' }), /cycle/);
});

const inactiveReferences: [string, CompositionDocument][] = [
  ['preset', { configurationPresets: { unused: { modelRef: 'preset:missing' } } }],
  [
    'component',
    { components: { agents: { unused: { prompt: 'Body', configuration: { modelRef: 'preset:missing' } } } } },
  ],
  ['group', { componentGroups: { unused: { configuration: { modelRef: 'preset:missing' } } } }],
  ['profile override', { profiles: { unused: { overrides: { agents: { build: { modelRef: 'preset:missing' } } } } } }],
];
for (const [location, document] of inactiveReferences) {
  test(`inactive ${location} rejects a missing model preset`, async (t) => {
    const input = await sources(t, document);
    await assert.rejects(resolveProfileRuntime(input, {}), /Model preset missing does not exist/);
  });
}

test('inactive native model references do not require an effective model until selected', async (t) => {
  const input = await sources(t, {
    configurationPresets: { unused: { modelRef: 'opencode:small_model' } },
    componentGroups: { unused: { agents: ['build'], configuration: { modelRef: 'preset:unused' } } },
    profiles: { unused: { layers: [{ componentGroup: 'unused' }] } },
    activeProfiles: [],
  });
  const result = await resolveProfileRuntime(input, {});
  assert.deepEqual(result.selectedAgents, []);
  assert.equal(result.small_model, undefined);
});

test('groups select authoritative native command names without duplicate definitions across reset', async (t) => {
  const { default: server } = await import('../src/server.ts');
  const input = await sources(t, {});
  const file = input.documents[0].path;
  const hooks = await server.server({ directory: dirname(file), worktree: dirname(file) } as PluginInput, {
    configFile: file,
  });
  const definitions = {
    componentGroups: { work: { commands: ['native-name'] } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
  };
  const original = { template: 'Native $ARGUMENTS', description: 'Host identity', agent: 'build' };
  const config: Config = { command: { 'native-name': original } };
  for (const activeProfiles of [['work'], [], ['work']]) {
    await writeFile(file, JSON.stringify({ ...definitions, activeProfiles }));
    await hooks.config!(config);
    assert.deepEqual(config.command, { 'native-name': original });
  }
  delete config.command!['native-name'];
  await hooks.config!(config);
  assert.deepEqual(config.command, {});
});
