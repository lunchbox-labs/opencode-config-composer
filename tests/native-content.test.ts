import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config, PluginInput } from '@opencode-ai/plugin';
import server from '../src/server.ts';

test('native text, inline component bodies and provider options remain opaque across replay', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-content-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'config-composer.jsonc');
  await writeFile(
    file,
    JSON.stringify({
      components: {
        agents: {
          helper: {
            prompt: 'Helper body ${literal}',
            configuration: { parameters: { options: { prompt: { metadata: 'provider-owned' } } } },
          },
        },
        commands: { helper: { template: 'Command body ${literal}' } },
      },
      componentGroups: {
        work: { agents: ['helper', 'build'], commands: ['helper'], configuration: { model: 'fixture/model' } },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const hooks = await server.server({ directory: root, worktree: root } as PluginInput, { configFile: file });
  const config: Config = {
    model: 'fixture/model',
    agent: { build: { prompt: 'Native body ${literal}' } },
    command: { native: { template: 'Native command ${literal} $ARGUMENTS' } },
  };
  for (let i = 0; i < 2; i++) {
    await hooks.config!(config);
    assert.equal(config.agent?.build?.prompt, 'Native body ${literal}');
    assert.equal(config.agent.helper?.prompt, 'Helper body ${literal}');
    const params = hooks['chat.params']!;
    const input = {
      agent: 'helper',
      model: { providerID: 'fixture', id: 'model', api: { npm: '@ai-sdk/openai-compatible' }, limit: { output: 256 } },
    } as Parameters<typeof params>[0];
    const output = { options: {} } as Parameters<typeof params>[1];
    await params(input, output);
    assert.deepEqual(output.options.prompt, { metadata: 'provider-owned' });
    assert.equal(config.command?.helper.template, 'Command body ${literal}');
    assert.equal(config.command.native.template, 'Native command ${literal} $ARGUMENTS');
  }
});
