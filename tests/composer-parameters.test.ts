import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import server from '../src/server.ts';
import { readSettings, resolveChoice } from '../src/config-composer/settings.ts';
import { parseConfiguration } from '../src/config-composer/configuration.ts';

// Keep imports behind parser acceptance so RED demonstrates missing behavior, not a missing module.
async function parametersModule() {
  readSettings({ agent: { modelPresets: { sample: { model: 'a/model', parameters: { topK: 3 } } } } });
  return import('../src/config-composer/composition/parameters.ts');
}

test('bound parameters do not leak to another selected model', async () => {
  const { parametersForDispatch, parseParameters } = await parametersModule();
  assert.equal(parametersForDispatch('a/model', 'b/model', { options: { reasoningEffort: 'high' } }), undefined);
  assert.throws(() => parseParameters({ maxOutputTokens: -1 }));
  assert.deepEqual(parametersForDispatch('a/model', 'a/model', { topK: 3 }), { topK: 3 });
});

test('custom JSON retains all JSON types and rejects duplicate, unsafe, nonfinite, oversized and deep values', async () => {
  const { parseParameters, parseCustomOptions } = await parametersModule();
  const options = { text: 'high', number: 0.5, bool: false, array: [1, null], object: { nested: true }, nil: null };
  assert.deepEqual(parseParameters({ options }), { options });
  assert.deepEqual(parseCustomOptions(JSON.stringify(options)), options);
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":{"x":1,"x":2}}',
    '{',
    '[]',
    '{"__proto__":1}',
    '{"a":{"constructor":1}}',
    '{"x":1e400}',
    '{"x":1,}',
  ]) {
    assert.throws(() => parseCustomOptions(text));
  }
  assert.throws(() => parseCustomOptions(JSON.stringify({ text: 'x'.repeat(1024 * 1024) })));
  for (const options of [{ x: NaN }, { x: Infinity }, { x: undefined }, { x: 1n }, { x: new Date() }]) {
    assert.throws(() => parseParameters({ options }));
  }
  const nested = (levels: number): unknown => (levels === 0 ? null : { child: nested(levels - 1) });
  assert.doesNotThrow(() => parseParameters({ options: nested(32) }));
  assert.throws(() => parseParameters({ options: nested(33) }), /32/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => parseParameters({ options: cycle }));
  assert.throws(
    () =>
      readSettings(
        parseConfiguration('{"agent":{"modelPresets":{"x":{"model":"a/b","parameters":{"options":{"a":1,"a":2}}}}}}'),
      ),
    /duplicate/,
  );
});

test('native controls enforce generic ranges and schema destinations', async () => {
  const { parseParameters } = await parametersModule();
  assert.deepEqual(parseParameters({ temperature: 0, topP: 1, topK: 1, maxOutputTokens: 2 }), {
    temperature: 0,
    topP: 1,
    topK: 1,
    maxOutputTokens: 2,
  });
  for (const value of [
    { temperature: 2.01 },
    { temperature: -0.01 },
    { topP: 1.01 },
    { topP: -1 },
    { topK: 0 },
    { topK: 1.5 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: Infinity },
    { temperature: '1' },
    { topP: null },
    { unknown: 1 },
    { options: [] },
  ]) {
    assert.throws(() => parseParameters(value));
  }
  const schema = JSON.parse(await readFile(new URL('../schema.json', import.meta.url), 'utf8')) as {
    $defs: Record<string, { properties: Record<string, Record<string, unknown>> }>;
  };
  assert.equal(schema.$defs.parameters.properties.temperature.maximum, 2);
  assert.equal(schema.$defs.parameters.properties.topP.maximum, 1);
  assert.equal(schema.$defs.parameters.properties.topK.type, 'integer');
  assert.equal(schema.$defs.preset.properties.parameters.$ref, '#/$defs/parameters');
  assert.equal(schema.$defs.group.properties.parameters.$ref, '#/$defs/parameters');
});

test('same identity merges parameters while changed identity or reference resets model-bound fields and pins win', async () => {
  await parametersModule();
  const groups = readSettings({
    agent: {
      groups: {
        first: { model: 'a/one', variant: 'high', parameters: { topK: 2, options: { keep: true, replace: 1 } } },
        same: { model: 'a/one', parameters: { topP: 0.2, options: { replace: 2 } } },
        changed: { model: 'a/two' },
        reference: { modelRef: 'preset:other' },
      },
      modelPresets: { other: { model: 'a/one' } },
    },
  });
  assert.deepEqual(resolveChoice({ groups: ['first', 'same'] }, groups.groups).parameters, {
    topK: 2,
    topP: 0.2,
    options: { keep: true, replace: 2 },
  });
  const changed = resolveChoice({ groups: ['first', 'changed'] }, groups.groups);
  assert.equal(changed.parameters, undefined);
  assert.equal(changed.variant, undefined);
  const rebound = resolveChoice({ groups: ['first', 'reference'] }, groups.groups, groups);
  assert.equal(rebound.parameters, undefined);
  assert.equal(rebound.variant, undefined);
  assert.equal(resolveChoice({ groups: ['first'], model: 'a/one' }, groups.groups).parameters, undefined);
  assert.throws(() => readSettings({ agent: { groups: { invalid: { parameters: { topK: 1 } } } } }));
});

test('metadata distinguishes capability/catalog evidence from unverified custom provider support', async () => {
  const { parameterMetadata, filterParameters } = await parametersModule();
  const model = {
    capabilities: { temperature: false },
    limit: { output: 128 },
    options: { observed: 'value' },
    variants: { high: { reasoningEffort: 'high' } },
  };
  const metadata = parameterMetadata(model, { options: { observed: 'other', unknown: null } });
  assert.equal(metadata.controls.temperature.available, false);
  assert.equal(metadata.options.observed.validation, 'structural');
  assert.equal(metadata.options.observed.support, 'provider-unverified');
  assert.equal(metadata.options.observed.catalog, true);
  assert.equal(metadata.options.unknown.catalog, false);
  assert.equal(metadata.controls.topK.destination, 'chat.params.topK');
  assert.equal(metadata.hostVersion, '1.18.34');
  assert.deepEqual(filterParameters({ temperature: 1, topP: 0.3 }, model), { topP: 0.3 });
  assert.throws(() => filterParameters({ maxOutputTokens: 129 }, model), /output/);
});

test('dispatch retains native pins and variants, scopes small requests, and removes prior composition parameters', async (t) => {
  await parametersModule();
  const root = await mkdtemp(join(tmpdir(), 'composer-parameters-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'composer.jsonc');
  const settings = {
    agent: {
      groups: {
        one: {
          model: 'a/one',
          variant: 'low',
          parameters: {
            temperature: 0.4,
            topP: 0.7,
            topK: 5,
            maxOutputTokens: 64,
            options: { reasoningEffort: 'medium', nested: { kept: 1, pinned: 'composer' }, unknown: [true, null] },
          },
        },
      },
    },
  };
  await writeFile(file, JSON.stringify(settings));
  const hooks = await server.server({} as PluginInput, { configFile: file });
  const config: Parameters<NonNullable<Hooks['config']>>[0] = {
    agent: {
      worker: { groups: ['one'], temperature: 0.8, options: { nested: { pinned: 'native' } } },
      title: { groups: ['one'] },
      pinned: { groups: ['one'], model: 'a/one' },
    },
  };
  await hooks.config!(config);
  await hooks.config!(config);
  const dispatch = async (agent = 'worker', selected = 'one', variant?: string, temperature = true) => {
    const input = {
      agent,
      model: {
        providerID: 'a',
        id: selected,
        capabilities: { temperature },
        limit: { output: 128 },
        variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high', nested: { kept: 9 } } },
      },
      message: { variant },
      provider: {},
      sessionID: 'test',
    } as unknown as Parameters<NonNullable<Hooks['chat.params']>>[0];
    const output = {
      temperature: 0.8,
      topP: 1,
      topK: 1,
      maxOutputTokens: 128,
      options: { reasoningEffort: 'native', credential: 'untouched', nested: { pinned: 'native' } },
    };
    await hooks['chat.params']!(input, output);
    return output;
  };
  const result = await dispatch('worker', 'one', 'high');
  assert.equal(result.temperature, 0.8);
  assert.equal(result.topP, 0.7);
  assert.equal(result.topK, 5);
  assert.equal(result.maxOutputTokens, 64);
  assert.equal(result.options.reasoningEffort, 'native', 'do not overwrite already resolved variant output');
  assert.deepEqual(result.options.nested, { pinned: 'native' });
  assert.equal(result.options.credential, 'untouched');
  assert.equal((await dispatch('worker', 'two')).topK, 1);
  assert.equal((await dispatch('pinned')).topK, 1);
  assert.equal((await dispatch('title')).topK, 5);
  assert.equal((await dispatch('title', 'two')).topK, 1);
  assert.equal((await dispatch('title', 'one', undefined, false)).temperature, 0.8);
  await writeFile(file, JSON.stringify({ agent: { groups: { one: { model: 'a/two' } } } }));
  await hooks.config!(config);
  assert.equal((await dispatch('worker', 'two')).topK, 1);
  assert.equal(config.agent!.worker!.model, 'a/two');
  await writeFile(file, JSON.stringify({ agent: { groups: { one: {} } } }));
  await hooks.config!(config);
  assert.equal((await dispatch()).topK, 1);
});

test('known compatible adapter verifies string routing without inventing provider enums', async () => {
  const { filterParameters, parameterMetadata } = await parametersModule();
  const model = { providerID: 'custom', id: 'model', api: { npm: '@ai-sdk/openai-compatible' } };
  assert.throws(() => filterParameters({ options: { reasoningEffort: 4 } }, model), /string/);
  assert.throws(() => filterParameters({ options: { reasoningEffort: null } }, model), /string/);
  assert.deepEqual(filterParameters({ options: { reasoningEffort: 'future-value', unknown: null } }, model), {
    options: { reasoningEffort: 'future-value', unknown: null },
  });
  const metadata = parameterMetadata(model, { options: { reasoningEffort: 'high', unknown: null } });
  assert.equal(metadata.options.reasoningEffort.validation, 'adapter-verified');
  assert.equal(metadata.options.reasoningEffort.support, 'provider-unverified');
  assert.equal(metadata.options.unknown.validation, 'structural');
  assert.equal(metadata.adapter?.version, '2.0.41');
  assert.equal(metadata.adapter.family, 'OpenAI-compatible chat models');
  assert.equal(metadata.options.reasoningEffort.wireDestination, 'reasoning_effort');
  assert.equal(metadata.controls.temperature.minimum, 0);
  assert.equal(metadata.controls.temperature.maximum, 2);
  assert.equal(metadata.controls.topK.type, 'integer');
  assert.equal(metadata.controls.topK.available, false);
  assert.deepEqual(filterParameters({ topK: 4 }, model), {});
  assert.doesNotThrow(() => filterParameters({ options: { reasoningEffort: 4 } }, { api: { npm: 'unknown' } }));
});
