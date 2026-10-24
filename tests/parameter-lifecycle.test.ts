import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import descriptor from '../src/config-composer/server.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { readRuntimeContext } from '../src/config-composer/composition/runtime-baseline.ts';
import { readSelectionAt, saveSelection } from '../src/config-composer/composition/selection-state.ts';

type ParameterHook = NonNullable<Hooks['chat.params']>;
const request = {
  agent: 'worker',
  model: { providerID: 'p', id: 'alias', api: { npm: '@ai-sdk/anthropic' } },
  message: { model: { providerID: 'p', modelID: 'alias' } },
} as Parameters<ParameterHook>[0];
const defaults = () => ({
  temperature: 0.1,
  topP: 0.2,
  topK: 1,
  maxOutputTokens: 512,
  options: { native: true } as Record<string, unknown>,
});

test('server clears model parameters after failed apply and recovers without polluting native agents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-parameter-lifecycle-'));
  const keys = ['OPENCODE_CONFIG_DIR', 'OPENCODE_TEST_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'];
  const before = keys.map((key) => process.env[key]);
  keys.forEach((key) => (process.env[key] = root));
  t.after(async () => {
    keys.forEach((key, index) => {
      if (before[index] === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = before[index];
      }
    });
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'config-composer.jsonc');
  const parameters = {
    temperature: 0,
    top_p: 0,
    topK: 8,
    maxOutputTokens: 128,
    options: { reasoningEffort: 'low', nested: { flag: false } },
  };
  await writeFile(
    source,
    JSON.stringify({
      defaultProfile: 'a',
      groups: { coding: { agent: { modelRef: 'coding' } } },
      profiles: {
        a: { models: { coding: { model: 'p/alias', ...parameters } } },
        b: { models: { coding: { model: 'p/alias', maxOutputTokens: 64 } } },
      },
    }),
  );
  const input = { directory: root, worktree: root } as PluginInput;
  const hooks = await descriptor.server(input);
  const dispatch = async (hook: ParameterHook = hooks['chat.params']!) => {
    const output = defaults();
    await hook(request, output);
    return output;
  };
  assert.deepEqual(await dispatch(), defaults(), 'an unapplied instance has no model parameter bundle');
  const config = {
    plugin: [packageName],
    agent: { worker: { groups: ['coding'], model: 'p/native', prompt: 'NATIVE_BODY' } },
  };
  const location = { root, directory: root };
  await hooks.config!(config);
  const applied = readRuntimeContext(config, location);
  assert.deepEqual(applied.candidate?.modelParameters?.worker?.parameters, parameters);
  assert.deepEqual(config.agent.worker, { model: 'p/alias', variant: '', prompt: 'NATIVE_BODY' });
  assert.deepEqual(await dispatch(), {
    temperature: 0,
    topP: 0,
    topK: 8,
    maxOutputTokens: 128,
    options: { native: true, reasoningEffort: 'low', nested: { flag: false } },
  });

  // Definition edits stay deferred until process restart, even while saved choices change.
  await writeFile(source, '{ invalid after startup');
  await saveSelection(
    await readSelectionAt(applied.selectionEnvironment, applied.selectionLocator),
    'missing',
    async () => {},
  );
  await assert.rejects(hooks.config!(config), /Saved profile missing/);
  const failed = readRuntimeContext(config, location);
  assert.equal(failed.status, 'error');
  assert.equal(failed.candidate, undefined);
  assert.equal(failed.revision, undefined);
  assert.equal(config.agent.worker.model, 'p/alias', 'native may retain the prior model after a failed hook');
  assert.deepEqual(await dispatch(), defaults(), 'the retained model must not retain the failed instance bundle');

  await saveSelection(await readSelectionAt(failed.selectionEnvironment, failed.selectionLocator), 'b', async () => {});
  await hooks.config!(config);
  const recovered = readRuntimeContext(config, location);
  assert.equal(recovered.status, 'applied');
  assert.equal(recovered.definitionId, applied.definitionId);
  assert.deepEqual(recovered.candidate?.modelParameters?.worker?.parameters, { maxOutputTokens: 64 });
  assert.deepEqual(config.agent.worker, { model: 'p/alias', variant: '', prompt: 'NATIVE_BODY' });
  assert.deepEqual(await dispatch(), { ...defaults(), maxOutputTokens: 64 });

  const rebootstrap = await descriptor.server(input);
  assert.deepEqual(await dispatch(rebootstrap['chat.params']), defaults(), 'another instance cannot inherit a bundle');
  const fresh = { plugin: [packageName], agent: { worker: { groups: ['coding'], model: 'p/native' } } };
  await rebootstrap.config!(fresh);
  assert.deepEqual(await dispatch(rebootstrap['chat.params']), { ...defaults(), maxOutputTokens: 64 });
  assert.equal(readRuntimeContext(fresh, location).definitionId, applied.definitionId);
});
