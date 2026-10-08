import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type TestContext, test } from 'node:test';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import { composePrompts } from '../src/config-composer/prompts.ts';
import { type AgentSettings, readSettings } from '../src/config-composer/settings.ts';
import server from '../src/server.ts';

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'config-composer-prompts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'shared'));
  return root;
}

test('composition preserves authored text and applies default, group, and agent operations in order', async (t) => {
  const root = await directory(t);
  await writeFile(join(root, 'shared/inner.md'), 'Included');
  await writeFile(join(root, 'shared/outer.md'), 'Outer {{include:@shared/inner.md}}');
  const settings = readSettings({
    sourceDirectories: { shared: join(root, 'shared') },
    agent: {
      groups: {
        base: { prompt: { prepend: ['Base before'], append: ['Base after'] } },
        team: { prompt: { prepend: ['Team before'], append: ['Team after'] } },
      },
      prompts: {
        defaults: { prepend: ['Default before'], append: ['Default after'] },
        overrides: {
          worker: { prepend: ['@shared/outer.md'], append: ['Agent after'] },
          lead: { inheritDefaults: false, inheritGroups: false, append: ['Lead after'] },
        },
      },
    },
  });
  const agents = {
    worker: { groups: ['base', 'team'], prompt: 'Authored @shared/inner.md; \\{{include:@shared/inner.md}}' },
    lead: { groups: ['base'], prompt: 'Lead authored' },
    title: { groups: ['base'] },
    disabled: { disable: true, prompt: '{{include:@missing/file.md}}' },
  };
  const before = structuredClone(agents);
  const prompts = await composePrompts(agents, settings);
  assert.equal(
    prompts.worker,
    'Default before\n\nBase before\n\nTeam before\n\nOuter Included\n\nAuthored @shared/inner.md; {{include:@shared/inner.md}}\n\nDefault after\n\nBase after\n\nTeam after\n\nAgent after',
  );
  assert.equal(prompts.lead, 'Lead authored\n\nLead after');
  assert.equal(prompts.title, undefined);
  assert.equal(prompts.disabled, undefined);
  assert.deepEqual(agents, before);
});

test('includes reject missing paths, traversal, symlink escapes, unsafe text, cycles, and size limits', async (t) => {
  const root = await directory(t);
  const settings = readSettings({ sourceDirectories: { shared: join(root, 'shared') } });
  const attempt = (reference: string) => composePrompts({ worker: { prompt: `{{include:${reference}}}` } }, settings);
  await assert.rejects(attempt('@shared/missing.md'), /Could not read/);
  await assert.rejects(attempt('@missing/file.md'), /does not exist/);
  await assert.rejects(
    composePrompts({ worker: { prompt: '{{include:@shared/unclosed.md' } }, settings),
    /invalid syntax/,
  );
  for (const reference of [
    '@shared/../outside.md',
    '@shared/../../outside.md',
    '@shared/.env',
    '@shared/file.json',
    '@shared/sub\\file.md',
  ]) {
    await assert.rejects(attempt(reference), /safe relative/);
  }
  await writeFile(join(root, 'outside.md'), 'Outside');
  await symlink(join(root, 'outside.md'), join(root, 'shared/escape.md'));
  await assert.rejects(attempt('@shared/escape.md'), /escapes/);
  await writeFile(join(root, 'shared/.env'), 'Hidden');
  await symlink(join(root, 'shared/.env'), join(root, 'shared/hidden.md'));
  await assert.rejects(attempt('@shared/hidden.md'), /unsafe file path/);
  await mkdir(join(root, 'shared/.hidden'));
  await writeFile(join(root, 'shared/.hidden/token.txt'), 'Hidden');
  await symlink(join(root, 'shared/.hidden/token.txt'), join(root, 'shared/hidden-directory.md'));
  await assert.rejects(attempt('@shared/hidden-directory.md'), /unsafe file path/);
  await writeFile(join(root, 'shared/valid.md'), 'Valid');
  await symlink(join(root, 'shared/valid.md'), join(root, 'shared/valid-link.md'));
  assert.deepEqual(await attempt('@shared/valid-link.md'), { worker: 'Valid' });
  await writeFile(join(root, 'shared/binary.md'), Buffer.from([0xff]));
  await assert.rejects(attempt('@shared/binary.md'), /Could not read/);
  await writeFile(join(root, 'shared/nul.md'), 'Text\0secret');
  await assert.rejects(attempt('@shared/nul.md'), /NUL/);
  await writeFile(join(root, 'shared/cycle.md'), '{{include:@shared/cycle.md}}');
  await assert.rejects(attempt('@shared/cycle.md'), /cycle/);
  await writeFile(join(root, 'shared/large.md'), 'a'.repeat(65537));
  await assert.rejects(attempt('@shared/large.md'), /64 KiB/);
  await writeFile(join(root, 'shared/limit.md'), 'a'.repeat(65536));
  await assert.rejects(
    composePrompts({ worker: { prompt: '{{include:@shared/limit.md}}'.repeat(5) } }, settings),
    /256 KiB/,
  );
  await writeFile(join(root, 'shared/flood.md'), '{{include:@shared/empty.md}}'.repeat(257));
  await writeFile(join(root, 'shared/empty.md'), '');
  await assert.rejects(attempt('@shared/flood.md'), /count or nesting/);
});

test('server stages every model and prompt before mutation and recomposes without repeated guidance', async (t) => {
  const root = await directory(t);
  const file = join(root, 'config-composer.jsonc');
  await writeFile(
    file,
    JSON.stringify({
      sourceDirectories: { shared: './shared' },
      defaults: { agents: { prompt: { append: ['Default after'] } } },
      componentGroups: { developers: { configuration: { modelRef: 'preset:balanced' } } },
      configurationPresets: { balanced: { model: 'fixture/fast', variant: 'high' } },
      profiles: { work: { layers: [{ componentGroup: 'developers' }] } },
      activeProfiles: ['work'],
    }),
  );
  const hooks = await server.server({} as PluginInput, { configFile: file });
  let agents: Record<string, AgentSettings> = {
    good: { groups: ['developers'], prompt: 'Authored' },
    bad: { groups: ['developers'], prompt: '{{include:@shared/missing.md}}' },
    title: { groups: ['developers'] },
  };
  const before = structuredClone(agents);
  await assert.rejects(hooks.config!({ agent: agents }), /Could not read/);
  assert.deepEqual(agents, before);
  await writeFile(join(root, 'shared/missing.md'), 'Now available');
  const next = { agent: agents };
  await hooks.config!(next);
  assert.deepEqual(agents, before, 'native input remains unchanged');
  agents = next.agent;
  assert.equal(agents.good.model, 'fixture/fast');
  assert.equal(agents.good.variant, 'high');
  assert.equal(agents.good.prompt, 'Authored\n\nDefault after');
  assert.equal(agents.title.prompt, undefined);
  await hooks.config!(next);
  agents = next.agent;
  assert.equal(agents.good.prompt, 'Authored\n\nDefault after');
  assert.equal(agents.bad.prompt, 'Now available\n\nDefault after');
  assert.equal(agents.good.model, 'fixture/fast');
});

test('skill output expands nested includes, preserves native context, and rereads sources without agent layers', async (t) => {
  const root = await directory(t);
  await writeFile(join(root, 'shared/inner.md'), 'Included guidance');
  await writeFile(join(root, 'shared/outer.md'), 'Outer {{include:@shared/inner.md}}');
  const file = join(root, 'config-composer.jsonc');
  await writeFile(
    file,
    JSON.stringify({
      sourceDirectories: { shared: './shared' },
      defaults: { agents: { prompt: { append: ['Agent guidance only'] } } },
    }),
  );
  const hooks = await server.server({} as PluginInput, { configFile: file });
  const hook = hooks['tool.execute.after'];
  assert.ok(hook !== undefined, 'Config Composer must expand native skill output');
  type Params = Parameters<NonNullable<Hooks['tool.execute.after']>>;
  const input: Params[0] = { tool: 'skill', sessionID: 'session', callID: 'call', args: { name: 'example' } };
  const authored =
    '<skill_content name="example">\n# Skill: example\n\n{{include:@shared/outer.md}}\n' +
    'Task reference: @shared/inner.md; literal: \\{{include:@shared/inner.md}}\n\n' +
    'Base directory for this skill: file:///example\n<skill_files>\n<file>/example/asset.txt</file>\n</skill_files>\n</skill_content>';
  const metadata = { name: 'example', dir: '/example', marker: '{{include:@shared/inner.md}}' };
  const output: Params[1] = { title: 'Loaded skill: example', output: authored, metadata };
  await hook(input, output);
  const expected = authored
    .replace('{{include:@shared/outer.md}}', 'Outer Included guidance')
    .replace('\\{{include:@shared/inner.md}}', '{{include:@shared/inner.md}}');
  assert.equal(output.output, expected);
  assert.equal(output.title, 'Loaded skill: example');
  assert.equal(output.metadata, metadata, 'preserve native metadata without rewriting its values');
  assert.deepEqual(metadata, { name: 'example', dir: '/example', marker: '{{include:@shared/inner.md}}' });
  await writeFile(join(root, 'shared/inner.md'), 'Updated guidance');
  output.output = authored;
  await hook(input, output);
  assert.equal(output.output, expected.replace('Included guidance', 'Updated guidance'));
});

test('skill output failures leave the result unchanged and other tool outputs remain literal', async (t) => {
  const root = await directory(t);
  await writeFile(join(root, 'shared/valid.md'), 'Valid guidance');
  const file = join(root, 'config-composer.jsonc');
  await writeFile(file, JSON.stringify({ sourceDirectories: { shared: './shared' } }));
  const hooks = await server.server({} as PluginInput, { configFile: file });
  const hook = hooks['tool.execute.after'];
  assert.ok(hook !== undefined, 'Config Composer must expand native skill output');
  type Params = Parameters<NonNullable<Hooks['tool.execute.after']>>;
  const input: Params[0] = { tool: 'skill', sessionID: 'session', callID: 'call', args: { name: 'example' } };
  const output: Params[1] = {
    title: 'Loaded skill: example',
    output: 'Before {{include:@shared/valid.md}} then {{include:@shared/missing.md}} after',
    metadata: { name: 'example', dir: '/example' },
  };
  const before = structuredClone(output);
  await assert.rejects(hook(input, output), /Could not read/);
  assert.deepEqual(output, before, 'a later invalid include cannot expose a partial expansion');
  await writeFile(join(root, 'outside.md'), 'Outside source guidance');
  output.output = '{{include:@shared/../outside.md}}';
  const unsafe = structuredClone(output);
  await assert.rejects(hook(input, output), /safe relative/);
  assert.deepEqual(output, unsafe, 'skill expansion retains the configured source boundary');
  output.output = 'Skill body with a native truncation notice';
  output.metadata = { name: 'example', dir: '/example', truncated: true };
  const truncated = structuredClone(output);
  await assert.rejects(hook(input, output), /truncated/i);
  assert.deepEqual(output, truncated, 'reject truncated skill output even when no include marker survives');
  output.output = '{{include:@unknown/file.md}}';
  const literal = structuredClone(output);
  await hook({ ...input, tool: 'read' }, output);
  assert.deepEqual(output, literal, 'only native skill output is templated');
  output.output = 'Ordinary skill body with a task reference to @unknown/file.md';
  output.metadata = { name: 'example', dir: '/example', truncated: false };
  const ordinary = structuredClone(output);
  await hook(input, output);
  assert.deepEqual(output, ordinary, 'ordinary skill bodies do not require composition sources');
});

test('recomposition reloads fragments, removes prior inherited fields, and retains changed explicit fields', async (t) => {
  const root = await directory(t);
  await writeFile(join(root, 'shared/worker.md'), 'First');
  const file = join(root, 'config-composer.jsonc');
  await writeFile(
    file,
    JSON.stringify({
      sourceDirectories: { shared: './shared' },
      componentGroups: { base: { configuration: { modelRef: 'opencode:model' } } },
      profiles: { work: { layers: [{ componentGroup: 'base' }] } },
      activeProfiles: ['work'],
    }),
  );
  const hooks = await server.server({} as PluginInput, { configFile: file });
  let worker: AgentSettings = { groups: ['base'], prompt: '{{include:@shared/worker.md}}' };
  const compose = async (model: string) => {
    const config = { model, agent: { worker } };
    await hooks.config!(config);
    worker = config.agent.worker;
  };
  await compose('fixture/first');
  assert.equal(worker.model, 'fixture/first');
  await writeFile(join(root, 'shared/worker.md'), 'Second');
  await compose('fixture/second');
  assert.equal(worker.model, 'fixture/second');
  assert.equal(worker.prompt, 'Second');
  worker.groups = [];
  await compose('fixture/second');
  assert.equal(worker.model, undefined);
  worker.model = 'fixture/pinned';
  worker.variant = 'high';
  worker.prompt = 'New authored prompt';
  await compose('fixture/second');
  assert.equal(worker.model, 'fixture/pinned');
  assert.equal(worker.variant, 'high');
  assert.equal(worker.prompt, 'New authored prompt');
  const variantFile = join(root, 'variant.jsonc');
  await writeFile(
    variantFile,
    JSON.stringify({
      componentGroups: { base: { configuration: { model: 'fixture/first', variant: 'low' } } },
      profiles: { work: { layers: [{ componentGroup: 'base' }] } },
      activeProfiles: ['work'],
    }),
  );
  const variantHooks = await server.server({} as PluginInput, { configFile: variantFile });
  let inherited: AgentSettings = { groups: ['base'], prompt: 'Authored' };
  const candidate = { agent: { inherited } };
  await variantHooks.config!(candidate);
  inherited = candidate.agent.inherited;
  assert.equal(inherited.variant, 'low');
  inherited.groups = [];
  await variantHooks.config!(candidate);
  inherited = candidate.agent.inherited;
  assert.equal(inherited.model, undefined);
  assert.equal(inherited.variant, undefined);
});

test('dispatch clears prior variants across ordered model identity changes', async (t) => {
  const root = await directory(t);
  const configFile = join(root, 'config-composer.jsonc');
  await writeFile(
    configFile,
    JSON.stringify({
      componentGroups: {
        base: { configuration: { model: 'fixture/fast', variant: 'high' } },
        later: { configuration: { model: 'fixture/small' } },
      },
      profiles: { work: { layers: [{ componentGroup: 'base' }, { componentGroup: 'later' }] } },
      activeProfiles: ['work'],
    }),
  );
  const hooks = await server.server({} as PluginInput, { configFile });
  const worker: AgentSettings = { groups: ['base', 'later'], prompt: 'Authored' };
  await hooks.config!({ agent: { worker } });
  type Params = Parameters<NonNullable<Hooks['chat.params']>>;
  const input = {
    agent: 'worker',
    model: { providerID: 'fixture', id: 'small', variants: {} },
  } as unknown as Params[0];
  const output = {
    options: { groups: ['base', 'later'], unrelated: true },
  } as unknown as Params[1];
  assert.equal(worker.variant, undefined);
  await hooks['chat.params']!(input, output);
  assert.deepEqual(output.options, { unrelated: true });
  await hooks['chat.params']!(
    {
      ...input,
      message: { variant: 'low' },
      model: { providerID: 'fixture', id: 'small', variants: { low: {} } },
    } as unknown as Params[0],
    output,
  );
});
