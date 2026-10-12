import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Config, PluginInput } from '@opencode-ai/plugin';
import server from '../src/server.ts';
import { CompositionValidationError, readCompositionDocument } from '../src/config-composer/composition/document.ts';

for (const [pointer, value] of [
  ['/sourceDirectories', { sourceDirectories: {} }],
  ['/components/prompts', { components: { prompts: {} } }],
  ['/components/agents/worker/promptRefs', { components: { agents: { worker: { prompt: 'Body', promptRefs: [] } } } }],
  ['/componentGroups/work/prompts', { componentGroups: { work: { prompts: [] } } }],
  [
    '/componentGroups/work/configuration/prompt',
    { componentGroups: { work: { configuration: { prompt: { append: ['Tail'] } } } } },
  ],
  [
    '/components/agents/worker/configuration/prompt',
    { components: { agents: { worker: { prompt: 'Body', configuration: { prompt: {} } } } } },
  ],
  ['/defaults/agents/prompt', { defaults: { agents: { prompt: {} } } }],
  ['/overrides/agents/worker/prompt', { overrides: { agents: { worker: { prompt: {} } } } }],
  [
    '/profiles/work/overrides/agents/worker/prompt',
    { profiles: { work: { overrides: { agents: { worker: { prompt: { inheritDefaults: false } } } } } } },
  ],
  ['/promptSources', { promptSources: {} }],
  ['/promptDefaults', { promptDefaults: {} }],
  ['/agentPrompts', { agentPrompts: {} }],
] as const) {
  test(`removed prompt setting ${pointer} reports its source and migration destination`, () => {
    assert.throws(
      () => readCompositionDocument(value, 'shared.jsonc'),
      (error: unknown) => {
        assert.ok(error instanceof CompositionValidationError);
        assert.equal(error.diagnostic.pointer, pointer);
        assert.equal(error.diagnostic.sourceId, 'shared.jsonc');
        assert.equal(error.diagnostic.code, 'removed-prompt-composition');
        assert.match(error.message, /@lunchbox-labs\/opencode-prompt-composer/);
        return true;
      },
    );
  });
}

test('native text, inline component bodies and lookalike provider options remain opaque across replay', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'config-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'config-composer.jsonc');
  await writeFile(
    file,
    JSON.stringify({
      components: {
        agents: {
          helper: {
            prompt: '{{include:@missing/helper.md}}',
            configuration: { parameters: { options: { prompt: { append: ['provider-owned'] } } } },
          },
        },
        commands: { helper: { template: '{{include:@missing/command.md}}' } },
      },
      componentGroups: {
        work: { agents: ['helper', 'build'], commands: ['helper'], configuration: { model: 'fixture/model' } },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const hooks = await server.server({ directory: root, worktree: root } as PluginInput, { configFile: file });
  assert.equal(hooks['tool.execute.after'], undefined, 'Config Composer has no skill-output expansion hook');
  const config: Config = {
    model: 'fixture/model',
    agent: { build: { prompt: '{{include:@missing/native.md}}' } },
    command: { native: { template: '\\{{include:@missing/native-command.md}} $ARGUMENTS' } },
  };
  for (let i = 0; i < 2; i++) {
    await hooks.config!(config);
    assert.equal(config.agent?.build?.prompt, '{{include:@missing/native.md}}');
    assert.equal(config.agent.helper?.prompt, '{{include:@missing/helper.md}}');
    assert.equal(config.command?.helper.template, '{{include:@missing/command.md}}');
    assert.equal(config.command.native.template, '\\{{include:@missing/native-command.md}} $ARGUMENTS');
  }
});
