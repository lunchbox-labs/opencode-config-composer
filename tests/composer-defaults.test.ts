import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import server from '../src/server.ts';
import { readSettings } from '../src/config-composer/settings.ts';

test('Composer defaults override independently', async () => {
  // Parser acceptance is part of the feature, before exercising its resolver.
  assert.equal(readSettings({ model: 'b/main' }).model, 'b/main');
  const { resolveNativeDefaults } = await import('../src/config-composer/composition/defaults.ts');
  assert.deepEqual(resolveNativeDefaults({ model: 'a/main', small_model: 'a/small' }, { model: 'b/main' }), {
    model: 'b/main',
    small_model: 'a/small',
  });
  for (const field of ['model', 'small_model'] as const) {
    for (const native of [undefined, 'a/native']) {
      for (const composer of [undefined, 'b/composer']) {
        const expected = composer ?? native;
        assert.deepEqual(
          resolveNativeDefaults(
            native === undefined ? {} : { [field]: native },
            composer === undefined ? {} : { [field]: composer },
          ),
          expected === undefined ? {} : { [field]: expected },
        );
      }
    }
  }
});

test('default validation matches the schema and rejects references and malformed IDs', async () => {
  const schema = JSON.parse(await readFile(new URL('../schema.json', import.meta.url), 'utf8')) as {
    properties: Record<string, { type: string; pattern: string }>;
  };
  for (const field of ['model', 'small_model']) {
    assert.equal(schema.properties[field].type, 'string');
    for (const value of [
      'fixture/main',
      'fixture/path/model',
      '',
      'main',
      'opencode:model',
      'a/white space',
      null,
      12,
    ]) {
      const valid = typeof value === 'string' && /^[^\s/]+\/\S+$/.test(value);
      assert.equal(typeof value === 'string' && new RegExp(schema.properties[field].pattern).test(value), valid);
      if (valid) {
        assert.doesNotThrow(() => readSettings({ [field]: value }));
      } else {
        assert.throws(() => readSettings({ [field]: value }), /provider\/model/);
      }
    }
  }
});

test('hooks stage overlays, restore removed defaults, and retain external changes and explicit pins', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'composer.jsonc');
  const nativeFile = join(root, 'opencode.jsonc');
  const agent = {
    main: { groups: ['main'], prompt: 'Authored' },
    small: { groups: ['small'] },
    pinned: { groups: ['main'], model: 'pin/model', variant: 'high' },
  };
  const native = { model: 'native/main', small_model: 'native/small', agent };
  const bytes = `// Unmodified native file\n${JSON.stringify(native)}`;
  await writeFile(nativeFile, bytes);
  const composition = {
    model: 'composer/main',
    small_model: 'composer/small',
    agent: {
      groups: { main: { modelRef: 'opencode:model' }, small: { modelRef: 'opencode:small_model' } },
      prompts: { defaults: { append: ['After'] } },
    },
  };
  await writeFile(file, JSON.stringify(composition));
  const hooks = await server.server({} as PluginInput, { configFile: file });
  const config: Parameters<NonNullable<Hooks['config']>>[0] = structuredClone(native);
  await hooks.config!(config);
  await hooks.config!(config);
  assert.equal(config.model, 'composer/main');
  assert.equal(config.small_model, 'composer/small');
  assert.equal(config.agent!.main!.model, 'composer/main');
  assert.equal(config.agent!.small!.model, 'composer/small');
  assert.equal(config.agent!.main!.prompt, 'Authored\n\nAfter');
  assert.equal(config.agent!.pinned!.model, 'pin/model');
  assert.equal(config.agent!.pinned!.variant, 'high');
  // Removing only one default restores its underlying value independently.
  await writeFile(file, JSON.stringify({ ...composition, model: undefined }));
  await hooks.config!(config);
  assert.equal(config.model, 'native/main');
  assert.equal(config.agent!.main!.model, 'native/main');
  assert.equal(config.small_model, 'composer/small');
  config.model = 'external/main';
  await writeFile(file, JSON.stringify({ agent: composition.agent }));
  await hooks.config!(config);
  assert.equal(config.model, 'external/main');
  assert.equal(config.small_model, 'native/small');
  assert.equal(config.agent!.small!.model, 'native/small');
  assert.equal(await readFile(nativeFile, 'utf8'), bytes);

  // New input must not inherit the previous object's native values.
  const absent = {};
  await writeFile(file, JSON.stringify({ model: 'composer/main', small_model: 'composer/small' }));
  await hooks.config!(absent);
  await writeFile(file, '{}');
  await hooks.config!(absent);
  assert.deepEqual(absent, {});

  // Neither a failed reference nor failed prompt expansion may publish any patch.
  const before = structuredClone(config);
  await writeFile(file, JSON.stringify({ model: 'next/main', agent: { groups: {} } }));
  await assert.rejects(hooks.config!(config), /unknown/);
  assert.deepEqual(config, before);
  await writeFile(
    file,
    JSON.stringify({
      ...composition,
      agent: { ...composition.agent, prompts: { defaults: { append: ['{{include:@missing/file.md}}'] } } },
    }),
  );
  await assert.rejects(hooks.config!(config));
  assert.deepEqual(config, before);
});
