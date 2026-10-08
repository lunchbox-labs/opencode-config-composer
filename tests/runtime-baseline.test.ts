import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config as PluginConfig } from '@opencode-ai/plugin';
import type { Config as NativeConfig } from '@opencode-ai/sdk/v2';
type Config = PluginConfig & Pick<NativeConfig, 'default_agent' | 'skills'>;
import { packageName } from '../src/config-composer/package-name.ts';
import {
  publishRuntimeBaseline,
  readRuntimeChoices as readChoices,
  readRuntimeBaseline,
  readRuntimeRevision,
} from '../src/config-composer/composition/runtime-baseline.ts';
import type { ResolvedModelSettings } from '../src/config-composer/composition/runtime.ts';
import { SettingsError, record } from '../src/config-composer/settings.ts';

const context = { root: '/project', directory: '/project/subdir' };
const observedNativeFiles = 'a'.repeat(64);
const revision = { sources: 'b'.repeat(64), effective: 'c'.repeat(64) };

function marker(config: Config): Record<string, unknown> {
  const entry = config.plugin?.[0];
  assert.ok(Array.isArray(entry));
  const value: unknown = entry[1].__configComposerRuntime;
  assert.ok(record(value));
  return value;
}

function choicesConfig(choices: Record<string, ResolvedModelSettings> = {}): Config {
  const config: Config = { plugin: [packageName], model: 'fixture/composer' };
  publishRuntimeBaseline(config, {}, context, {}, {}, { observedNativeFiles, revision, choices });
  return config;
}

test('native default agent is attested and later changes reject stale editor baselines', () => {
  const config: Config = { plugin: [packageName], default_agent: 'worker' };
  publishRuntimeBaseline(config, {}, context, { default_agent: 'worker' });
  assert.equal(readRuntimeBaseline(config, context).default_agent, 'worker');
  config.default_agent = 'plan';
  assert.throws(() => readRuntimeBaseline(config, context), /default_agent changed/);
});

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

test('applied choices publication snapshots caller-owned values without mutating registration options', () => {
  const choices = {
    worker: {
      model: 'fixture/composer',
      modelRef: 'preset:worker',
      variant: 'high',
      parameters: { temperature: 0.2, options: { nested: { amount: 3 }, stop: ['end'] } },
    },
  };
  const expected = structuredClone(choices);
  const options = { reloadToken: 'saved-token' };
  const original: NonNullable<Config['plugin']> = [[packageName, options]];
  const config: Config = { plugin: original };
  publishRuntimeBaseline(config, options, context, {}, {}, { observedNativeFiles, revision, choices });
  assert.deepEqual(marker(config).appliedChoices, expected);
  choices.worker.model = 'fixture/saved-but-unapplied';
  choices.worker.parameters.options.nested.amount = 8;
  assert.deepEqual(marker(config).appliedChoices, expected);
  assert.deepEqual(original, [[packageName, { reloadToken: 'saved-token' }]]);
});

test('partial applied choices publish strict JSON without changing undefined dispatch fields', () => {
  const choices = {
    worker: { model: undefined, modelRef: undefined, variant: undefined, parameters: undefined },
    partial: {
      model: 'fixture/composer',
      parameters: { temperature: undefined, topP: 0.8, options: undefined },
    },
  };
  const original = structuredClone(choices);
  const config = choicesConfig(choices);
  const expected = { worker: {}, partial: { model: 'fixture/composer', parameters: { topP: 0.8 } } };
  assert.deepEqual(marker(config).appliedChoices, expected);
  assert.deepEqual(readChoices(config, context).choices, expected);
  assert.deepEqual(marker(config), JSON.parse(JSON.stringify(marker(config))));
  assert.deepEqual(choices, original);
  assert.equal(Object.hasOwn(choices.worker, 'model'), true);
});

test('applied choices reads return isolated copies with the attested runtime ID', () => {
  const choices = {
    worker: {
      model: 'fixture/composer',
      variant: 'high',
      parameters: { options: { nested: { amount: 3 }, stop: ['end'] } },
    },
    fallback: {},
  };
  const config = choicesConfig(choices);
  const read = readChoices(config, context);
  assert.equal(read.id, readRuntimeRevision(config, context).id);
  assert.deepEqual(read.choices, choices);
  read.choices.worker.model = 'fixture/changed';
  const nested = read.choices.worker.parameters.options.nested;
  assert.ok(record(nested));
  nested.amount = 8;
  const stop = read.choices.worker.parameters.options.stop;
  assert.ok(Array.isArray(stop));
  stop.push('later');
  assert.deepEqual(readChoices(config, context).choices, choices);
  assert.deepEqual(marker(config).appliedChoices, choices);
});

test('older runtime markers remain readable but cannot supply absent applied choices', () => {
  const config: Config = { plugin: [packageName] };
  publishRuntimeBaseline(config, {}, context, {}, {}, { observedNativeFiles, revision });
  assert.deepEqual(readRuntimeBaseline(config, context), { agent: {} });
  assert.deepEqual(readRuntimeRevision(config, context).revision, revision);
  assert.throws(() => readChoices(config, context), {
    name: 'Error',
    message: /choices.*unavailable|unavailable.*choices/i,
  });
});

test('applied choices require current matching globals, agents, commands, skills and revision metadata', () => {
  const mutations: ((config: Config) => void)[] = [
    (config) => {
      config.model = 'fixture/later';
    },
    (config) => {
      config.agent = { worker: { model: 'fixture/later' } };
    },
    (config) => {
      config.command = { later: { template: 'later' } };
    },
    (config) => {
      config.skills = { paths: ['/later'] };
    },
    (config) => {
      marker(config).observedNativeFiles = 'invalid';
    },
    (config) => {
      marker(config).revision = { sources: 'invalid', effective: revision.effective };
    },
    (config) => {
      const entry = config.plugin![0];
      assert.ok(Array.isArray(entry));
      config.plugin = [['another-plugin', entry[1]]];
    },
  ];
  for (const mutate of mutations) {
    const config = choicesConfig({ worker: { model: 'fixture/composer' } });
    mutate(config);
    assert.throws(() => readChoices(config, context), SettingsError);
  }
  assert.throws(() => readChoices(choicesConfig(), { ...context, directory: '/elsewhere' }), SettingsError);
});

test('applied choices reject malformed values and unsafe prototype keys', () => {
  const inheritedParameters: unknown = Object.create({ temperature: 0.1 });
  const inheritedChoice: unknown = Object.create({ model: 'fixture/inherited' });
  const malformed: unknown[] = [
    undefined,
    null,
    [],
    { worker: null },
    { worker: [] },
    { worker: { model: 1 } },
    { worker: { variant: false } },
    { worker: { modelRef: 1 } },
    { worker: { secret: 'unexpected' } },
    { worker: { parameters: { temperature: 3 } } },
    { worker: { parameters: { topK: 0 } } },
    { worker: { parameters: { topP: 1.1 } } },
    { worker: { parameters: { maxOutputTokens: 1.5 } } },
    { worker: { parameters: { options: { value: Infinity } } } },
    { worker: { parameters: inheritedParameters } },
    JSON.parse('{"__proto__":{"model":"fixture/composer"}}'),
    JSON.parse('{"constructor":{"model":"fixture/composer"}}'),
    JSON.parse('{"worker":{"__proto__":{"polluted":true}}}'),
    JSON.parse('{"worker":{"parameters":{"options":{"nested":{"prototype":true}}}}}'),
    Object.create({ worker: { model: 'fixture/inherited' } }),
    { worker: inheritedChoice },
  ];
  for (const choices of malformed) {
    const config = choicesConfig();
    marker(config).appliedChoices = choices;
    assert.throws(() => readChoices(config, context), SettingsError);
  }
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});
