import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config as NativeConfig } from '@opencode-ai/sdk/v2';
import type { Config as PluginConfig, PluginInput } from '@opencode-ai/plugin';
import server from '../src/server.ts';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';
import { resolveProfileRuntime } from '../src/config-composer/composition/runtime.ts';
type Config = PluginConfig & Pick<NativeConfig, 'skills'>;
function agent(config: Config, name: string) {
  return config.agent?.[name];
}
function skillPaths(config: Config) {
  return config.skills?.paths;
}

async function fixture(t: TestContext, value: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'composer-profile-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode'));
  const file = join(root, 'composer.jsonc');
  await writeFile(file, JSON.stringify(value));
  const hooks = await server.server({ directory: root, worktree: root } as PluginInput, { configFile: file });
  return { root, file, hooks };
}

const definitions = {
  componentGroups: {
    coding: { agents: ['build', 'plan'], configuration: { model: 'fixture/alpha', variant: 'low' } },
    later: { agents: ['build'], configuration: { model: 'fixture/beta' } },
  },
  configurationPresets: { small: { modelRef: 'opencode:small_model', variant: 'high' } },
  profiles: {
    base: { layers: [{ componentGroup: 'coding' }] },
    coding: { extends: 'base', layers: [{ componentGroup: 'later' }] },
    small: { extends: 'base', layers: [{ configurationPreset: 'small', target: { agents: ['build'] } }] },
  },
  activeProfiles: ['coding', 'small'],
};

test('server activates ordered named profiles on built-ins without shadow component declarations', async (t) => {
  const f = await fixture(t, { ...definitions, defaults: { small_model: 'fixture/small' } });
  const nativePlan = {
    model: 'fixture/pinned',
    prompt: 'Keep native prompt',
    mode: 'primary' as const,
    permission: { bash: 'deny' as const },
  };
  const config: Config = { model: 'fixture/native', agent: { plan: structuredClone(nativePlan) } };
  await f.hooks.config!(config);
  assert.equal(agent(config, 'build')?.model, 'fixture/small');
  assert.equal(agent(config, 'build')?.variant, 'high');
  assert.equal(agent(config, 'build')?.prompt, undefined);
  assert.deepEqual(agent(config, 'plan'), nativePlan);
  assert.equal(config.small_model, 'fixture/small');
  assert.equal(config.model, 'fixture/native');
});

test('local selection replaces shared profiles and empty selection restores prior native fields', async (t) => {
  const f = await fixture(t, definitions);
  const config: Config = {};
  await writeFile(
    join(f.root, '.opencode/config-composer.local.jsonc'),
    JSON.stringify({ activeProfiles: ['coding'] }),
  );
  await f.hooks.config!(config);
  assert.equal(agent(config, 'build')?.model, 'fixture/beta');
  assert.equal(agent(config, 'build')?.variant, undefined, 'identity change clears earlier model-bound settings');
  await writeFile(join(f.root, '.opencode/config-composer.local.jsonc'), '{"activeProfiles":[]}');
  await f.hooks.config!(config);
  assert.equal(agent(config, 'build'), undefined, 'remove Composer-only overlay after deselection');
  assert.equal(agent(config, 'plan'), undefined);
});

test('selected groups union JSONC and discovered frontmatter agents and preserve native pins', async (t) => {
  const f = await fixture(t, {
    componentGroups: { coding: { agents: ['build'], configuration: { model: 'fixture/alpha' } } },
    profiles: { work: { layers: [{ componentGroup: 'coding' }] } },
    activeProfiles: ['work'],
  });
  const config: Config = {
    agent: {
      worker: { prompt: 'Custom', options: { groups: ['coding'] } },
      pinned: { model: 'fixture/pinned', options: { groups: ['coding'] } },
      idle: { prompt: 'Idle' },
    },
  };
  await f.hooks.config!(config);
  assert.equal(agent(config, 'worker')?.model, 'fixture/alpha');
  assert.equal(agent(config, 'pinned')?.model, 'fixture/pinned');
  assert.deepEqual(agent(config, 'idle'), { prompt: 'Idle' });
});

test('global precedence and references use effective model defaults while explicit agent overrides win', async (t) => {
  const f = await fixture(t, {
    ...definitions,
    defaults: { model: 'fixture/shared', small_model: 'fixture/first' },
    overrides: { small_model: 'fixture/final', agents: { plan: { model: 'fixture/override' } } },
  });
  await writeFile(
    join(f.root, '.opencode/config-composer.jsonc'),
    JSON.stringify({ defaults: { model: 'fixture/project' } }),
  );
  const config: Config = { model: 'fixture/native', agent: { plan: { model: 'fixture/pinned' } } };
  await f.hooks.config!(config);
  assert.equal(config.model, 'fixture/project');
  assert.equal(agent(config, 'build')?.model, 'fixture/final');
  assert.equal(agent(config, 'plan')?.model, 'fixture/override');
  await writeFile(f.file, '{}');
  await f.hooks.config!(config);
  assert.equal(agent(config, 'plan')?.model, 'fixture/pinned');
  assert.equal(config.small_model, undefined);
});

test('invalid selected targets and model-reference cycles leave native configuration unchanged', async (t) => {
  for (const value of [
    {
      ...definitions,
      activeProfiles: ['small'],
      configurationPresets: { small: { modelRef: 'preset:other' }, other: { modelRef: 'preset:small' } },
    },
    {
      ...definitions,
      profiles: { bad: { layers: [{ configurationPreset: 'small', target: { agents: ['build'] } }] } },
      activeProfiles: ['bad'],
    },
    {
      ...definitions,
      componentGroups: { coding: { agents: ['missing'] } },
      profiles: { bad: { layers: [{ componentGroup: 'coding' }] } },
      activeProfiles: ['bad'],
    },
  ]) {
    const f = await fixture(t, value);
    const config: Config = { model: 'fixture/native', agent: { worker: { prompt: 'Untouched' } } };
    const before = structuredClone(config);
    await assert.rejects(f.hooks.config!(config), /cycle|selected|unavailable/);
    assert.deepEqual(config, before);
  }
});

test('imported agent files retain frontmatter and activate only through selected mixed groups', async (t) => {
  const f = await fixture(t, {});
  await mkdir(join(f.root, 'library'));
  await mkdir(join(f.root, 'library/checks'));
  await writeFile(
    join(f.root, 'library/reviewer.md'),
    '---\ndescription: Fixture reviewer\nmode: subagent\ngroups: [review]\npermission:\n  edit: deny\n---\nReview body.\n',
  );
  await writeFile(join(f.root, 'library/scope.md'), 'Shared scope.');
  await writeFile(
    join(f.root, 'library/checks/SKILL.md'),
    '---\nname: checks\ndescription: Fixture checks\n---\nOn demand only.',
  );
  await writeFile(
    join(f.root, 'library/definitions.jsonc'),
    JSON.stringify({
      components: {
        agents: {
          reviewer: { file: './reviewer.md', promptRefs: ['scope'], skills: ['checks'] },
          idle: { prompt: 'Inactive' },
        },
        prompts: { scope: { file: './scope.md' } },
        skills: { checks: { file: './checks/SKILL.md' } },
        commands: { review: { agent: 'reviewer', template: 'Review $ARGUMENTS' } },
      },
      componentGroups: {
        review: {
          agents: ['build'],
          commands: ['review'],
          skills: ['checks'],
          configuration: { model: 'fixture/review' },
        },
      },
      profiles: { work: { layers: [{ componentGroup: 'review' }] } },
    }),
  );
  await writeFile(f.file, '{"imports":["./library/definitions.jsonc"],"activeProfiles":["work"]}');
  const config: Config = {};
  await f.hooks.config!(config);
  assert.equal(agent(config, 'reviewer')?.model, 'fixture/review');
  assert.equal(agent(config, 'reviewer')?.description, 'Fixture reviewer');
  assert.equal(agent(config, 'reviewer')?.mode, 'subagent');
  assert.deepEqual(agent(config, 'reviewer')?.permission, { edit: 'deny' });
  assert.equal(agent(config, 'reviewer')?.prompt, 'Review body.\n\nShared scope.');
  assert.equal(agent(config, 'idle'), undefined);
  assert.equal(config.command?.review.template, 'Review $ARGUMENTS');
  assert.equal(config.command.review.agent, 'reviewer');
  assert.deepEqual(skillPaths(config), [join(f.root, 'library/checks')]);
  assert.notEqual(agent(config, 'reviewer')?.prompt?.includes('On demand only.'), true);
  config.skills!.paths!.push('/another-plugin');
  await writeFile(join(f.root, '.opencode/config-composer.local.jsonc'), '{"activeProfiles":[]}');
  await f.hooks.config!(config);
  assert.equal(agent(config, 'reviewer'), undefined);
  assert.equal(config.command.review, undefined);
  assert.deepEqual(skillPaths(config), ['/another-plugin']);
});

test('mixed groups reject missing components and unavailable command agents before mutation', async (t) => {
  for (const group of [{ skills: ['missing'] }, { commands: ['missing'] }, { prompts: ['missing'] }]) {
    const f = await fixture(t, {
      componentGroups: { work: group },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    });
    const config: Config = {};
    await assert.rejects(f.hooks.config!(config), /missing/);
    assert.deepEqual(config, {});
  }
});

test('same model override retains native variant and deselection restores fields removed by a changed model', async (t) => {
  const f = await fixture(t, {
    componentGroups: { work: { agents: ['plan'] } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
    overrides: { agents: { plan: { model: 'fixture/pinned' } } },
  });
  const config: Config = { agent: { plan: { model: 'fixture/pinned', variant: 'high' } } };
  await f.hooks.config!(config);
  assert.equal(agent(config, 'plan')?.variant, 'high');
  await writeFile(
    f.file,
    JSON.stringify({
      componentGroups: { work: { agents: ['plan'] } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
      overrides: { agents: { plan: { model: 'fixture/different' } } },
    }),
  );
  await f.hooks.config!(config);
  assert.equal(agent(config, 'plan')?.variant, undefined);
  await writeFile(f.file, '{}');
  await f.hooks.config!(config);
  assert.deepEqual(agent(config, 'plan'), { model: 'fixture/pinned', variant: 'high' });
});

test('canonical parameters dispatch only to their resolved model and retain native authority', async (t) => {
  const f = await fixture(t, {
    componentGroups: {
      work: {
        agents: ['build'],
        configuration: {
          model: 'fixture/alpha',
          parameters: {
            temperature: 0.4,
            maxOutputTokens: 200,
            options: { reasoningEffort: 'high', nested: { a: true } },
          },
        },
      },
    },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  await f.hooks.config!({});
  const params = f.hooks['chat.params']!;
  type Input = Parameters<typeof params>[0];
  type Output = Parameters<typeof params>[1];
  const input = {
    agent: 'build',
    model: { providerID: 'fixture', id: 'alpha', api: { npm: '@ai-sdk/openai-compatible' }, limit: { output: 256 } },
  } as Input;
  const output = { temperature: 1, options: { untouched: true } } as unknown as Output;
  await params(input, output);
  assert.equal(output.temperature, 0.4);
  assert.equal(output.maxOutputTokens, 200);
  assert.deepEqual(output.options, { untouched: true, reasoningEffort: 'high', nested: { a: true } });
  const different = { temperature: 1, options: {} } as unknown as Output;
  await params({ ...input, model: { ...input.model, id: 'beta' } }, different);
  assert.deepEqual(different, { temperature: 1, options: {} });
});

test('nested preset origins point to authored fields and preserve native overwritten candidates', async (t) => {
  const f = await fixture(t, {
    componentGroups: { work: { agents: ['build'], configuration: { modelRef: 'preset:first' } } },
    configurationPresets: {
      first: { modelRef: 'preset:second' },
      second: { model: 'fixture/alpha', variant: 'high', parameters: { temperature: 0.3 } },
    },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
    overrides: { agents: { build: { model: 'fixture/alpha' } } },
  });
  const sources = await loadCompositionSources({ root: f.root, baseFile: f.file, baseExplicit: true });
  const result = await resolveProfileRuntime(sources, { agent: { build: { variant: 'native-pin' } } });
  assert.equal(result.agent.build.variant, 'native-pin');
  assert.equal(result.choices.build.modelRef, undefined);
  const parameters = result.provenance['/agent/build/parameters/temperature'];
  assert.equal(parameters.pointer, '/configurationPresets/second/parameters/temperature');
  assert.equal(parameters.sourceId, f.file);
  assert.ok(parameters.references.some((value) => value.endsWith('#/configurationPresets/first')));
  assert.ok(parameters.references.some((value) => value.endsWith('#/configurationPresets/second')));
  assert.equal(result.provenance['/agent/build/variant'].operation, 'native');
  const other = await resolveProfileRuntime(sources, { agent: { build: { model: 'fixture/native', variant: 'low' } } });
  assert.equal(other.provenance['/agent/build/model'].overwritten[0].operation, 'native');
});

test('permission contributions retain authored order and canonical origins without claiming compilation', async (t) => {
  const f = await fixture(t, {
    defaults: { agents: { permissions: [{ tool: 'bash', action: 'deny' }] } },
    componentGroups: {
      work: { agents: ['build'], configuration: { permissions: [{ tool: 'bash', pattern: 'git *', action: 'ask' }] } },
    },
    configurationPresets: { loose: { permissions: [{ tool: 'bash', pattern: 'git status', action: 'allow' }] } },
    profiles: {
      work: { layers: [{ componentGroup: 'work' }, { configurationPreset: 'loose', target: { agents: ['build'] } }] },
    },
    activeProfiles: ['work'],
  });
  const sources = await loadCompositionSources({ root: f.root, baseFile: f.file, baseExplicit: true });
  const result = await resolveProfileRuntime(sources, {});
  assert.deepEqual(
    result.permissions.map((item) => item.rule.action),
    ['deny', 'ask', 'allow'],
  );
  assert.deepEqual(
    result.permissions.map((item) => item.origin.pointer),
    [
      '/defaults/agents/permissions/0/action',
      '/componentGroups/work/configuration/permissions/0/action',
      '/configurationPresets/loose/permissions/0/action',
    ],
  );
  const config = {};
  await assert.rejects(f.hooks.config!(config), /permission compiler/);
  assert.deepEqual(config, {}, 'staging atomicity only: the native host can still continue after this error');
});

test('prompt-only component settings do not pin an inherited model against later profile layers', async (t) => {
  const f = await fixture(t, {
    defaults: { agents: { model: 'fixture/default' } },
    components: { agents: { worker: { prompt: 'Body', configuration: { prompt: { append: ['Tail'] } } } } },
    componentGroups: { work: { agents: ['worker'], configuration: { model: 'fixture/group' } } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  const config: Config = {};
  await f.hooks.config!(config);
  assert.equal(agent(config, 'worker')?.model, 'fixture/group');
  assert.equal(agent(config, 'worker')?.prompt, 'Body\n\nTail');
});

test('partial parameters bind to the effective native global model without creating an agent model pin', async (t) => {
  const f = await fixture(t, {
    defaults: { model: 'fixture/global' },
    componentGroups: { work: { agents: ['build'], configuration: { parameters: { maxOutputTokens: 96 } } } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  const config: Config = {};
  await f.hooks.config!(config);
  assert.equal(agent(config, 'build')?.model, undefined);
  const params = f.hooks['chat.params']!;
  const output = { options: {} } as Parameters<typeof params>[1];
  await params(
    { agent: 'build', model: { providerID: 'fixture', id: 'global', limit: { output: 128 } } } as Parameters<
      typeof params
    >[0],
    output,
  );
  assert.equal(output.maxOutputTokens, 96);
});

test('replay retains unrelated native resource edits without treating Composer entries as native', async (t) => {
  const f = await fixture(t, {
    components: { commands: { work: { template: 'Work' } } },
    componentGroups: { work: { commands: ['work'] } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  const config: Config = { command: { native: { template: 'Original' } }, skills: { paths: ['/native'] } };
  await f.hooks.config!(config);
  config.command!.added = { template: 'Another plugin' };
  config.skills!.paths!.push('/other-plugin');
  await f.hooks.config!(config);
  assert.equal(config.command!.work.template, 'Work');
  await writeFile(f.file, '{}');
  await f.hooks.config!(config);
  assert.deepEqual(config.command, { native: { template: 'Original' }, added: { template: 'Another plugin' } });
  assert.deepEqual(config.skills!.paths, ['/native', '/other-plugin']);
});

test('model identity changes mark removed parameter field origins as unset', async (t) => {
  const f = await fixture(t, {
    componentGroups: {
      first: { agents: ['build'], configuration: { model: 'fixture/a', parameters: { temperature: 0.2 } } },
      second: { agents: ['build'], configuration: { model: 'fixture/b' } },
    },
    profiles: { work: { layers: [{ componentGroup: 'first' }, { componentGroup: 'second' }] } },
    activeProfiles: ['work'],
  });
  const sources = await loadCompositionSources({ root: f.root, baseFile: f.file, baseExplicit: true });
  const result = await resolveProfileRuntime(sources, {});
  assert.equal(result.choices.build.parameters, undefined);
  assert.equal(result.provenance['/agent/build/parameters/temperature'].operation, 'unset');
  assert.equal(
    result.provenance['/agent/build/parameters/temperature'].overwritten[0].pointer,
    '/componentGroups/first/configuration/parameters/temperature',
  );
});

test('file-backed agents reject mismatched identities and invalid native fields before injection', async (t) => {
  for (const metadata of [
    'name: other',
    'model: 123',
    'mode: invalid',
    'mode: [subagent]',
    'temperature: .nan',
    'disable: yes',
    'permission:\n  edit: unexpected',
  ]) {
    const f = await fixture(t, {
      components: { agents: { worker: { file: './worker.md' } } },
      componentGroups: { work: { agents: ['worker'] } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    });
    await writeFile(join(f.root, 'worker.md'), `---\n${metadata}\n---\nBody`);
    const config: Config = {};
    await assert.rejects(f.hooks.config!(config), /frontmatter|name|identity|native|permission/i);
    assert.deepEqual(config, {});
  }
});

test('command files retain native model settings', async (t) => {
  const f = await fixture(t, {
    components: { commands: { work: { file: './work.md' } } },
    componentGroups: { work: { commands: ['work'] } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  await writeFile(join(f.root, 'work.md'), '---\nmodel: fixture/command\nagent: build\n---\nCommand body.');
  const config: Config = {};
  await f.hooks.config!(config);
  assert.equal(config.command?.work.model, 'fixture/command');
});

test('canonical agent variant pins and overridden preset origins survive group composition', async (t) => {
  const f = await fixture(t, {
    components: { agents: { worker: { prompt: 'Body', configuration: { variant: 'pin' } } } },
    configurationPresets: { base: { model: 'fixture/a', variant: 'high' } },
    componentGroups: {
      work: { agents: ['build', 'worker'], configuration: { modelRef: 'preset:base', variant: 'low' } },
    },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  const sources = await loadCompositionSources({ root: f.root, baseFile: f.file, baseExplicit: true });
  const result = await resolveProfileRuntime(sources, {});
  assert.equal(result.agent.worker.variant, 'pin');
  const variant = result.provenance['/agent/build/variant'];
  assert.equal(variant.pointer, '/componentGroups/work/configuration/variant');
  assert.ok(variant.overwritten.some((item) => item.pointer === '/configurationPresets/base/variant'));
});

test('parameter subtree replacements invalidate inherited descendant origins within and across layers', async (t) => {
  for (const layered of [false, true]) {
    const f = await fixture(t, {
      configurationPresets: { base: { model: 'fixture/a', parameters: { options: { nested: { leaf: 1 } } } } },
      componentGroups: {
        first: {
          agents: ['build'],
          configuration: { modelRef: 'preset:base', ...(layered ? {} : { parameters: { options: { nested: null } } }) },
        },
        second: { agents: ['build'], configuration: { parameters: { options: { nested: null } } } },
      },
      profiles: { work: { layers: [{ componentGroup: 'first' }, ...(layered ? [{ componentGroup: 'second' }] : [])] } },
      activeProfiles: ['work'],
    });
    const sources = await loadCompositionSources({ root: f.root, baseFile: f.file, baseExplicit: true });
    const result = await resolveProfileRuntime(sources, {});
    assert.equal(result.choices.build.parameters?.options?.nested, null);
    assert.equal(result.provenance['/agent/build/parameters/options/nested/leaf'].operation, 'unset');
  }
});

test('generated agent ownership survives unrelated external edits and replacement objects across recomposition', async (t) => {
  const value = {
    components: { agents: { worker: { prompt: 'Original body' } } },
    componentGroups: { work: { agents: ['worker'], configuration: { model: 'fixture/first', variant: 'low' } } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  };
  const f = await fixture(t, value);
  const config: Config = {};
  await f.hooks.config!(config);
  config.agent!.worker = { ...config.agent!.worker, description: 'External description', options: { external: true } };
  await writeFile(
    f.file,
    JSON.stringify({
      ...value,
      components: { agents: { worker: { prompt: 'Updated body' } } },
      componentGroups: { work: { agents: ['worker'], configuration: { model: 'fixture/second' } } },
    }),
  );
  await f.hooks.config!(config);
  assert.equal(agent(config, 'worker')?.description, 'External description');
  assert.equal(agent(config, 'worker')?.model, 'fixture/second');
  assert.equal(agent(config, 'worker')?.variant, undefined);
  assert.equal(agent(config, 'worker')?.prompt, 'Updated body');
  assert.deepEqual(agent(config, 'worker')?.options, { external: true });
  await f.hooks.config!(config);
  assert.equal(agent(config, 'worker')?.description, 'External description');
  await writeFile(join(f.root, '.opencode/config-composer.local.jsonc'), '{"activeProfiles":[]}');
  await f.hooks.config!(config);
  assert.deepEqual(agent(config, 'worker'), { description: 'External description', options: { external: true } });
  await writeFile(join(f.root, '.opencode/config-composer.local.jsonc'), '{"activeProfiles":["work"]}');
  await f.hooks.config!(config);
  assert.equal(agent(config, 'worker')?.model, 'fixture/second');
  assert.equal(agent(config, 'worker')?.description, 'External description');
});

test('externally edited generated commands retain their template after deselection', async (t) => {
  const f = await fixture(t, {
    components: { commands: { example: { template: 'Body' } } },
    componentGroups: { work: { commands: ['example'] } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  const config: Config = {};
  await f.hooks.config!(config);
  config.command!.example.description = 'External description';
  await writeFile(join(f.root, '.opencode/config-composer.local.jsonc'), '{"activeProfiles":[]}');
  await f.hooks.config!(config);
  assert.deepEqual(config.command!.example, { template: 'Body', description: 'External description' });
});

test('an installation without optional sources publishes a native baseline for first-source creation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-bootstrap-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, 'OPENCODE_CONFIG_DIR');
    } else {
      process.env.OPENCODE_CONFIG_DIR = previous;
    }
  });
  const { packageName } = await import('../src/config-composer/package-name.ts');
  const { readRuntimeBaseline } = await import('../src/config-composer/composition/runtime-baseline.ts');
  const hooks = await server.server({ directory: root, worktree: root } as PluginInput);
  const config: Config = {
    plugin: [packageName],
    model: 'fixture/native',
    agent: { worker: { prompt: 'Native body.' } },
  };
  await hooks.config!(config);
  assert.deepEqual(readRuntimeBaseline(config, { root, directory: root }), {
    model: 'fixture/native',
    agent: { worker: { prompt: 'Native body.' } },
  });
  await assert.rejects(
    server.server({ directory: root, worktree: root } as PluginInput, {
      configFile: join(root, 'explicitly-missing.jsonc'),
    }),
    /Cannot|missing|read|exist/i,
  );
  await writeFile(join(root, 'config-composer.jsonc'), '{broken');
  await assert.rejects(hooks.config!(config), /JSONC|syntax|invalid/i);
});
