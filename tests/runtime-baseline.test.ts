import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '@opencode-ai/plugin';
import { packageName } from '../src/config-composer/package-name.ts';
import { publishRuntimeBaseline, readRuntimeBaseline } from '../src/config-composer/composition/runtime-baseline.ts';

const context = { root: '/project', directory: '/project/subdir' };

test('runtime baseline metadata preserves native absent slots and never mutates source registration options', () => {
  const options = { reloadToken: 'saved-token' };
  const original: NonNullable<Config['plugin']> = [[packageName, options]];
  const config: Config = { plugin: original, model: 'fixture/composer', small_model: 'fixture/composer-small' };
  publishRuntimeBaseline(config, options, context, { model: 'fixture/native' });
  assert.deepEqual(readRuntimeBaseline(config, context), { model: 'fixture/native', agent: {} });
  assert.deepEqual(original, [[packageName, { reloadToken: 'saved-token' }]]);
  assert.notEqual(config.plugin, original);
  assert.equal(config.model, 'fixture/composer');
});

test('bare package registrations publish a copied runtime tuple and support baseline refresh', () => {
  const config: Config = { plugin: [packageName], model: 'fixture/composer' };
  publishRuntimeBaseline(config, {}, context, {});
  assert.deepEqual(readRuntimeBaseline(config, context), { agent: {} });
  publishRuntimeBaseline(config, {}, context, { small_model: 'fixture/native-small' });
  assert.deepEqual(readRuntimeBaseline(config, context), { small_model: 'fixture/native-small', agent: {} });
});

test('missing baseline, changed workspace, and globals changed by a later plugin block exact previews', () => {
  const config: Config = { plugin: [packageName], model: 'fixture/composer' };
  assert.throws(() => readRuntimeBaseline(config, context), /baseline|reload/i);
  publishRuntimeBaseline(config, {}, context, { model: 'fixture/native' });
  assert.throws(
    () => readRuntimeBaseline(config, { ...context, directory: '/other' }),
    /workspace|directory|baseline/i,
  );
  config.model = 'fixture/later-plugin';
  assert.throws(() => readRuntimeBaseline(config, context), /changed|baseline/i);
});

test('later agent changes and metadata on a foreign plugin cannot masquerade as a native baseline', () => {
  const config: Config = { plugin: [packageName], agent: { worker: { model: 'fixture/native' } } };
  publishRuntimeBaseline(config, {}, context, {}, { worker: { model: 'fixture/native' } });
  config.agent!.worker!.model = 'fixture/later';
  assert.throws(() => readRuntimeBaseline(config, context), /Agent settings changed/);
  const entry = config.plugin![0];
  assert.ok(Array.isArray(entry));
  config.plugin = [['another-plugin', entry[1]]];
  assert.throws(() => readRuntimeBaseline(config, context), /missing|ambiguous/);
});
