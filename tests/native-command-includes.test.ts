import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { Config, PluginInput } from '@opencode-ai/plugin';
import server from '../src/server.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-command-includes-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'snippets'));
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = root;
  t.after(async () => {
    if (previous === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, 'config-composer.jsonc');
  await writeFile(file, JSON.stringify({ sourceDirectories: { snippets: './snippets' } }));
  const hooks = await server.server({ directory: project, worktree: project } as PluginInput);
  return { root, project, file, hooks };
}

test('native commands expand nested includes once, preserve metadata and substitutions, and leave baseline objects untouched', async (t) => {
  const { root, hooks } = await fixture(t);
  await writeFile(join(root, 'snippets/outer.md'), ' Outer {{include:@snippets/inner.txt}} ');
  await writeFile(join(root, 'snippets/inner.txt'), 'Inner \\{{include:@missing/literal.md}}');
  const baseline = {
    first: {
      template: 'Before {{include:@snippets/outer.md}} after $ARGUMENTS $1 !`echo hello` @file.ts',
      description: 'Native description',
      agent: 'build',
      model: 'fixture/pinned',
      subtask: true,
    },
    second: { template: '\\{{include:@missing/escaped.md}}' },
  };
  const before = structuredClone(baseline);
  const config: Config = { command: baseline };
  const expected = 'Before Outer Inner {{include:@missing/literal.md}} after $ARGUMENTS $1 !`echo hello` @file.ts';
  for (let pass = 0; pass < 2; pass++) {
    await hooks.config!(config);
    assert.deepEqual(config.command?.first, { ...before.first, template: expected });
    assert.equal(config.command.second.template, '{{include:@missing/escaped.md}}');
    assert.deepEqual(Object.keys(config.command), ['first', 'second']);
    assert.deepEqual(baseline, before);
  }
  config.command!.first.description = 'Updated by another plugin';
  await writeFile(join(root, 'snippets/inner.txt'), 'Changed');
  await hooks.config!(config);
  assert.equal(config.command!.first.template, expected.replace('Inner {{include:@missing/literal.md}}', 'Changed'));
  assert.equal(config.command!.first.description, 'Updated by another plugin');
  config.command!.first.template = 'Replacement $ARGUMENTS';
  await hooks.config!(config);
  assert.equal(config.command!.first.template, 'Replacement $ARGUMENTS');
  assert.deepEqual(baseline, before);
});

test('native includes survive profile changes and clearing without re-expanding Composer command output', async (t) => {
  const { root, file, hooks } = await fixture(t);
  await writeFile(join(root, 'snippets/body.md'), 'Body');
  const definitions = {
    sourceDirectories: { snippets: './snippets' },
    components: { commands: { composed: { template: '\\{{include:@missing/literal.md}}' } } },
    componentGroups: { work: { commands: ['composed'] } },
    profiles: { a: { layers: [{ componentGroup: 'work' }] }, b: { layers: [] } },
  };
  const config: Config = { command: { native: { template: '{{include:@snippets/body.md}}' } } };
  for (const activeProfiles of [['a'], ['b'], ['a'], []]) {
    await writeFile(file, JSON.stringify({ ...definitions, activeProfiles }));
    await hooks.config!(config);
    assert.equal(config.command!.native.template, 'Body');
    assert.deepEqual(Object.keys(config.command!), activeProfiles[0] === 'a' ? ['native', 'composed'] : ['native']);
    if (activeProfiles[0] === 'a') {
      assert.equal(config.command!.composed.template, '{{include:@missing/literal.md}}');
    }
  }
});

test('native includes resolve aliases relative to imported documents', async (t) => {
  const { root, file, hooks } = await fixture(t);
  await mkdir(join(root, 'library/text'), { recursive: true });
  await writeFile(join(root, 'library/text/body.md'), 'Imported');
  await writeFile(join(root, 'library/definitions.jsonc'), '{"sourceDirectories":{"shared":"./text"}}');
  await writeFile(file, '{"imports":["./library/definitions.jsonc"]}');
  const config: Config = { command: { native: { template: '{{include:@shared/body.md}}' } } };
  await hooks.config!(config);
  assert.equal(config.command!.native.template, 'Imported');
});

test('native include errors reject before publishing a partial command or agent composition', async (t) => {
  const { root, file, hooks } = await fixture(t);
  await writeFile(join(root, 'snippets/good.md'), 'Good');
  await writeFile(join(root, 'snippets/cycle.md'), '{{include:@snippets/cycle.md}}');
  await writeFile(join(root, 'outside.md'), 'Outside');
  await symlink(join(root, 'outside.md'), join(root, 'snippets/escape.md'));
  await writeFile(join(root, 'snippets/large.md'), 'x'.repeat(65537));
  await writeFile(
    file,
    JSON.stringify({ sourceDirectories: { snippets: './snippets' }, defaults: { model: 'fixture/changed' } }),
  );
  for (const [template, error] of [
    ['{{include:@missing/body.md}}', /does not exist/],
    ['{{include:@snippets/missing.md}}', /Could not read/],
    ['{{include:', /invalid syntax/],
    ['{{include:@snippets/../outside.md}}', /safe relative/],
    ['{{include:@snippets/escape.md}}', /escapes/],
    ['{{include:@snippets/cycle.md}}', /cycle/],
    ['{{include:@snippets/large.md}}', /64 KiB/],
    ['{{include:@snippets/good.md}}'.repeat(257), /count or nesting/],
  ] as const) {
    const command = { good: { template: '{{include:@snippets/good.md}}' }, bad: { template } };
    const config: Config = { model: 'fixture/native', agent: { build: { prompt: 'Native' } }, command };
    await assert.rejects(hooks.config!(config), error);
    assert.equal(config.command, command);
    assert.equal(config.command.good.template, '{{include:@snippets/good.md}}');
    assert.equal(config.model, 'fixture/native');
    assert.deepEqual(config.agent, { build: { prompt: 'Native' } });
  }
});

test('native command collisions retain their existing error before expansion', async (t) => {
  const { file, hooks } = await fixture(t);
  await writeFile(
    file,
    JSON.stringify({
      components: { commands: { duplicate: { template: 'Composer' } } },
      componentGroups: { work: { commands: ['duplicate'] } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const config: Config = { command: { duplicate: { template: '{{include:@missing/body.md}}' } } };
  await assert.rejects(hooks.config!(config), /conflicts with an existing native command/);
});
