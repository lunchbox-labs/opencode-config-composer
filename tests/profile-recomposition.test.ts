import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config as PluginConfig, PluginInput } from '@opencode-ai/plugin';
import type { Config as NativeConfig } from '@opencode-ai/sdk/v2';
import server from '../src/server.ts';
import { packageName } from '../src/config-composer/package-name.ts';

type Config = PluginConfig & Pick<NativeConfig, 'default_agent' | 'skills'>;
type Hooks = Awaited<ReturnType<typeof server.server>>;

async function fixture(
  t: TestContext,
  globals: { model?: string; small_model?: string } = { model: 'fixture/shared', small_model: 'fixture/base-small' },
) {
  const root = await mkdtemp(join(tmpdir(), 'composer-profile-recomposition-'));
  const directory = join(root, 'config');
  const project = join(root, 'project');
  await mkdir(directory);
  await mkdir(join(project, '.opencode'), { recursive: true });
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = directory;
  t.after(async () => {
    if (previous === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  });
  const native: Config = {
    plugin: [packageName],
    model: 'fixture/shared',
    small_model: 'fixture/native-small',
    default_agent: 'build',
    permission: { edit: 'ask' },
    agent: {
      build: {
        prompt: 'NATIVE_BUILD',
        options: { nativeOnly: true, nested: { native: 'kept', protected: 'native' } },
      },
      plan: {
        model: 'fixture/shared',
        variant: 'low',
        prompt: 'NATIVE_PLAN',
        temperature: 0.65,
        top_p: 0.75,
        options: { nested: { pin: 'native' } },
      },
    },
    command: { native: { template: 'NATIVE_COMMAND' } },
    skills: { paths: [join(root, 'native-skills')] },
  };
  const nativeBefore = structuredClone(native);
  const file = join(directory, 'config-composer.jsonc');
  const definitions = join(directory, 'definitions.jsonc');
  const nativeFile = join(directory, 'opencode.jsonc');
  const selection = join(project, '.opencode/config-composer.local.jsonc');
  await writeFile(nativeFile, '// Preserve the native configuration bytes.\n' + JSON.stringify(native));
  await writeFile(
    definitions,
    '// Reusable definitions remain untouched by profile selection.\n' +
      JSON.stringify({
        components: {
          agents: {
            worker: {
              prompt: 'COMPONENT_BODY',
              configuration: { parameters: { options: { componentOnly: true, nested: { component: 'base' } } } },
            },
          },
        },
        componentGroups: { members: { agents: ['build', 'plan', 'worker'] } },
        configurationPresets: {
          a: {
            model: 'fixture/shared',
            variant: 'high',
            parameters: {
              temperature: 0.2,
              topK: 4,
              maxOutputTokens: 96,
              options: { aOnly: true, nested: { aOnly: 'a', value: 'a', protected: 'composer' } },
            },
          },
          b: {
            model: 'fixture/shared',
            parameters: { topP: 0.5, options: { bOnly: true, nested: { bOnly: 'b', value: 'b' } } },
          },
        },
        profiles: {
          a: {
            layers: [
              { componentGroup: 'members' },
              { configurationPreset: 'a', target: { componentGroups: ['members'] } },
            ],
            overrides: { agents: { worker: { prompt: { append: ['A_PROMPT'] } } } },
          },
          b: {
            layers: [
              { componentGroup: 'members' },
              { configurationPreset: 'b', target: { componentGroups: ['members'] } },
            ],
          },
          'global-a': { extends: 'a', overrides: { model: 'fixture/a-global', small_model: 'fixture/a-small' } },
          'global-b': { extends: 'b' },
        },
      }),
  );
  await writeFile(
    file,
    '// Preserve the shared base and import registration.\n' +
      JSON.stringify({
        imports: ['./definitions.jsonc'],
        defaults: {
          ...globals,
          agents: {
            parameters: { topP: 0.8, topK: 2, options: { baseOnly: true, nested: { base: 'base', value: 'base' } } },
            prompt: { prepend: ['BASE_PROMPT'] },
          },
        },
      }),
  );
  const preservedFiles = [nativeFile, file, definitions];
  const preservedBytes = await Promise.all(preservedFiles.map((path) => readFile(path, 'utf8')));
  const hooks = () => server.server({ directory: project, worktree: project } as PluginInput, { configFile: file });
  const select = (profiles: string[]) => writeFile(selection, JSON.stringify({ activeProfiles: profiles }));
  const unchanged = async () => {
    assert.deepEqual(native, nativeBefore, 'shared native objects must never receive effective Composer values');
    assert.deepEqual(await Promise.all(preservedFiles.map((path) => readFile(path, 'utf8'))), preservedBytes);
  };
  return { native, nativeBefore, hooks, select, unchanged };
}

async function dispatch(hooks: Hooks, native: Config, name: string) {
  const params = hooks['chat.params']!;
  const original = native.agent?.[name];
  const output = {
    temperature: original?.temperature ?? 1,
    topP: original?.top_p ?? 1,
    options: structuredClone(original?.options ?? {}),
  } as Parameters<typeof params>[1];
  await params(
    {
      agent: name,
      model: {
        providerID: 'fixture',
        id: 'shared',
        variants: { low: {}, high: {} },
        limit: { output: 256 },
      },
    } as unknown as Parameters<typeof params>[0],
    output,
  );
  return output;
}

async function effective(config: Config, hooks: Hooks, native: Config) {
  return {
    model: config.model,
    small_model: config.small_model,
    default_agent: config.default_agent,
    permission: config.permission,
    agent: structuredClone(config.agent),
    command: structuredClone(config.command),
    skills: structuredClone(config.skills),
    build: await dispatch(hooks, native, 'build'),
    plan: await dispatch(hooks, native, 'plan'),
    ...(config.agent?.worker === undefined ? {} : { worker: await dispatch(hooks, native, 'worker') }),
  };
}

async function fresh(f: Awaited<ReturnType<typeof fixture>>) {
  const hooks = await f.hooks();
  const config: Config = { ...f.native };
  await hooks.config!(config);
  return effective(config, hooks, f.native);
}

function assertB(value: Awaited<ReturnType<typeof effective>>, native: Config) {
  assert.equal(value.agent?.build?.model, 'fixture/shared');
  assert.equal(value.agent.build.variant, undefined, 'B omits A’s variant despite using the same model');
  assert.equal(value.agent.worker?.variant, undefined);
  assert.equal(value.agent.worker?.prompt, 'BASE_PROMPT\n\nCOMPONENT_BODY');
  assert.deepEqual(value.agent.plan, { ...native.agent?.plan, prompt: 'BASE_PROMPT\n\nNATIVE_PLAN' });
  assert.deepEqual(value.build, {
    temperature: 1,
    topP: 0.5,
    topK: 2,
    options: {
      nativeOnly: true,
      baseOnly: true,
      bOnly: true,
      nested: { native: 'kept', protected: 'native', base: 'base', value: 'b', bOnly: 'b' },
    },
  });
  assert.deepEqual(value.worker, {
    temperature: 1,
    topP: 0.5,
    topK: 2,
    options: {
      baseOnly: true,
      componentOnly: true,
      bOnly: true,
      nested: { base: 'base', value: 'b', component: 'base', bOnly: 'b' },
    },
  });
  assert.deepEqual(value.plan, { temperature: 0.65, topP: 0.75, options: { nested: { pin: 'native' } } });
}

for (const retainAgentReferences of [false, true]) {
  test(`same-model A → B → A → none rebuilds the base ${retainAgentReferences ? 'when native outer configs retain agent references' : 'when the config object is reused'}`, async (t) => {
    const f = await fixture(t);
    const hooks = await f.hooks();
    let config: Config = { ...f.native };
    const apply = async (profiles: string[]) => {
      await f.select(profiles);
      if (retainAgentReferences) {
        // The host supplies native globals/resources; only agent objects retain hook ownership.
        config = { ...f.native, agent: config.agent };
      }
      await hooks.config!(config);
      const result = await effective(config, hooks, f.native);
      assert.deepEqual(
        result,
        await fresh(f),
        'recomposition must match the destination built from original native inputs',
      );
      await f.unchanged();
      return result;
    };
    const firstA = await apply(['a']);
    assert.equal(firstA.agent?.build?.variant, 'high');
    assert.equal(firstA.build.temperature, 0.2);
    assert.equal(firstA.build.maxOutputTokens, 96);
    assert.equal(firstA.build.topK, 4);
    assert.equal(firstA.worker?.options.aOnly, true);
    assert.match(firstA.agent.worker?.prompt ?? '', /A_PROMPT/);
    assertB(await apply(['b']), f.native);
    assert.deepEqual(await apply(['a']), firstA, 'returning to A must exactly restore A without B-only values');
    const none = await apply([]);
    assert.deepEqual(none.agent, f.nativeBefore.agent);
    assert.equal(none.model, 'fixture/shared');
    assert.equal(none.small_model, 'fixture/base-small');
    assert.deepEqual(none.build, { temperature: 1, topP: 1, options: f.nativeBefore.agent?.build?.options });
    assert.equal(none.worker, undefined, 'clearing selection removes the generated component agent');
  });
}

test('same-model options inherit within current ordered profiles while replacing the selection removes old contributions', async (t) => {
  const f = await fixture(t);
  const hooks = await f.hooks();
  const config: Config = { ...f.native };
  const apply = async (profiles: string[]) => {
    await f.select(profiles);
    await hooks.config!(config);
    const result = await effective(config, hooks, f.native);
    assert.deepEqual(result, await fresh(f));
    await f.unchanged();
    return result;
  };
  const both = await apply(['a', 'b']);
  assert.equal(both.agent?.build?.variant, 'high', 'A remains selected in this ordered composition');
  assert.equal(both.build.temperature, 0.2);
  assert.equal(both.build.topP, 0.5);
  assert.equal(both.build.maxOutputTokens, 96);
  assert.deepEqual(both.build.options.nested, {
    native: 'kept',
    protected: 'native',
    base: 'base',
    value: 'b',
    aOnly: 'a',
    bOnly: 'b',
  });
  assert.equal(both.build.options.aOnly, true);
  assert.equal(both.build.options.bOnly, true);
  const reverse = await apply(['b', 'a']);
  assert.deepEqual(reverse.build.options.nested, { ...both.build.options.nested, value: 'a' });
  assertB(await apply(['b']), f.native);
});

test('fresh instance hooks compose destinations from shared native inputs without changing already composed instances', async (t) => {
  const f = await fixture(t);
  await f.select(['a']);
  const firstHooks = await f.hooks();
  const first: Config = { ...f.native };
  await firstHooks.config!(first);
  const firstA = await effective(first, firstHooks, f.native);
  await f.select(['b']);
  assertB(await fresh(f), f.native);
  assert.deepEqual(
    await effective(first, firstHooks, f.native),
    firstA,
    'another instance must not change A’s config or dispatch',
  );
  await f.select(['a']);
  assert.deepEqual(await fresh(f), firstA);
  await f.select([]);
  const none = await fresh(f);
  assert.deepEqual(none.agent, f.nativeBefore.agent);
  assert.equal(none.worker, undefined);
  await f.unchanged();
});

test('profile globals restore source base values and omitted native fallbacks on switch and clear', async (t) => {
  const f = await fixture(t, { model: 'fixture/base', small_model: undefined });
  const hooks = await f.hooks();
  const config: Config = { ...f.native };
  for (const profiles of [['global-a'], ['global-b'], ['global-a'], []]) {
    await f.select(profiles);
    await hooks.config!(config);
    assert.deepEqual(await effective(config, hooks, f.native), await fresh(f));
    assert.equal(config.model, profiles[0] === 'global-a' ? 'fixture/a-global' : 'fixture/base');
    assert.equal(config.small_model, profiles[0] === 'global-a' ? 'fixture/a-small' : 'fixture/native-small');
    assert.equal(config.default_agent, 'build');
    assert.deepEqual(config.permission, f.nativeBefore.permission);
    await f.unchanged();
  }
});

test('an explicit same-model profile override restores the original native variant when the destination omits it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-native-variant-recomposition-'));
  await mkdir(join(root, '.opencode'));
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
  const native: Config = {
    plugin: [packageName],
    model: 'fixture/shared',
    agent: {
      worker: {
        model: 'fixture/shared',
        variant: 'low',
        prompt: 'NATIVE_WORKER',
        options: { protected: 'native', nested: { base: 'native' } },
      },
    },
  };
  const original = structuredClone(native);
  const nativeFile = join(root, 'opencode.jsonc');
  const definitions = join(root, 'definitions.jsonc');
  const file = join(root, 'config-composer.jsonc');
  const selection = join(root, '.opencode/config-composer.local.jsonc');
  await writeFile(nativeFile, '// Original native variant and options.\n' + JSON.stringify(native));
  await writeFile(
    definitions,
    '// Reusable presets and profiles are immutable during switching.\n' +
      JSON.stringify({
        componentGroups: { members: { agents: ['worker'] } },
        configurationPresets: {
          a: {
            model: 'fixture/shared',
            variant: 'high',
            parameters: {
              temperature: 0.2,
              maxOutputTokens: 96,
              options: { protected: 'composer', nested: { aOnly: true } },
            },
          },
          b: { model: 'fixture/shared', parameters: { topP: 0.5, options: { nested: { bOnly: true } } } },
        },
        profiles: {
          a: {
            layers: [{ componentGroup: 'members' }],
            overrides: { agents: { worker: { modelRef: 'preset:a' } } },
          },
          b: {
            layers: [{ componentGroup: 'members' }],
            overrides: { agents: { worker: { modelRef: 'preset:b' } } },
          },
        },
      }),
  );
  await writeFile(file, '// Preserve the shared import.\n' + JSON.stringify({ imports: ['./definitions.jsonc'] }));
  const preservedFiles = [nativeFile, definitions, file];
  const preservedBytes = await Promise.all(preservedFiles.map((path) => readFile(path, 'utf8')));
  const createHooks = () => server.server({ directory: root, worktree: root } as PluginInput, { configFile: file });
  const hooks = await createHooks();
  const config: Config = { ...native };
  let firstA: Awaited<ReturnType<typeof effective>> | undefined;
  for (const profiles of [['a'], ['b'], ['a'], []]) {
    await writeFile(selection, JSON.stringify({ activeProfiles: profiles }));
    await hooks.config!(config);
    const actual = await effective(config, hooks, native);
    const destinationHooks = await createHooks();
    const destination: Config = { ...native };
    await destinationHooks.config!(destination);
    assert.deepEqual(actual, await effective(destination, destinationHooks, native));
    assert.equal(config.agent?.worker?.model, 'fixture/shared');
    assert.equal(config.agent.worker.variant, profiles[0] === 'a' ? 'high' : 'low');
    assert.equal(actual.worker?.options.protected, 'native');
    if (profiles[0] === 'a') {
      assert.equal(actual.worker.temperature, 0.2);
      assert.equal(actual.worker.maxOutputTokens, 96);
      assert.deepEqual(actual.worker.options.nested, { base: 'native', aOnly: true });
      if (firstA === undefined) {
        firstA = actual;
      } else {
        assert.deepEqual(actual, firstA);
      }
    } else if (profiles[0] === 'b') {
      assert.deepEqual(actual.worker, {
        temperature: 1,
        topP: 0.5,
        options: { protected: 'native', nested: { base: 'native', bOnly: true } },
      });
    } else {
      assert.deepEqual(config.agent.worker, original.agent?.worker);
      assert.deepEqual(actual.worker, { temperature: 1, topP: 1, options: original.agent?.worker?.options });
    }
    assert.deepEqual(native, original);
    assert.deepEqual(await Promise.all(preservedFiles.map((path) => readFile(path, 'utf8'))), preservedBytes);
  }
});
