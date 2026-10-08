import assert from 'node:assert/strict';
import { editorServerConfig } from './editor-server-config.ts';
import { type TestContext, test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import type {
  TuiDialogAlertProps,
  TuiDialogConfirmProps,
  TuiDialogPromptProps,
  TuiDialogSelectProps,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui';
import { registerSettings } from '../src/config-composer/tui.ts';
import { applyEdits, modify } from 'jsonc-parser';
import {
  type AgentSettings,
  agentGroups,
  applyDefaults,
  catalogModels,
  readSettings,
  resolveChoice,
  validateChoice,
} from '../src/config-composer/settings.ts';
import server from '../src/server.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { fileURLToPath } from 'node:url';
import {
  groupNames,
  loadSnapshot,
  parseConfig,
  planChange,
  reloadConfiguration,
  savePlan,
} from '../src/config-composer/storage.ts';

const groups = { developers: { model: 'example/fast', variant: 'medium' }, reviewers: { model: 'example/deep' } };
const config = `{
  // Keep this comment and trailing comma.
  "plugin": ["${packageName}"],
  "model": "example/global",
  "small_model": "example/small",
  "permission": {"edit": "ask"},
  "agent": {
    "builtin": {"groups": ["developers"], "permission": {"edit": "deny"}},
    "disabled": {"disable": true, "groups": ["hidden"]},
    "nested/pinned": {"model": "example/lower-pin", "variant": "low"},
  },
}
`;
const prompt = '---\n\n# Prompt\nPreserve this exact text.\n  Two spaces.\n';
const pinned = `---
description: 'Keep my quotes' # and this comment
groups: [developers]
model: example/exception
variant: high
permission:
  edit: deny
${prompt}`;

export async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'config-composer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agents', 'nested'), { recursive: true });
  await writeFile(join(root, 'opencode.jsonc'), config);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: Object.fromEntries(
        Object.entries({ ...groups, 'custom-team': {} }).map(([name, configuration]) => [name, { configuration }]),
      ),
      profiles: { work: { layers: Object.keys(groups).map((componentGroup) => ({ componentGroup })) } },
      activeProfiles: ['work'],
    }),
  );
  await writeFile(join(root, 'agents', 'nested', 'pinned.md'), pinned);
  await writeFile(join(root, 'agents', 'new.md'), `---\ngroups: [custom-team]\n${prompt}`);
  return root;
}

test('the editor recognizes package registrations and public local server entrypoints precisely', async (t) => {
  const root = await fixture(t);
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  for (const spec of [
    packageName,
    `${packageName}@1.2.3`,
    `${packageName}@next`,
    packageRoot,
    new URL('../', import.meta.url).href,
    fileURLToPath(new URL('../src/server.ts', import.meta.url)),
    new URL('../src/server.ts', import.meta.url).href,
  ]) {
    await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [spec] }));
    assert.equal((await loadSnapshot(root)).pluginIndex, 0, spec);
  }
  for (const spec of [
    `${packageName}-unrelated`,
    `${packageName}/tui`,
    `${packageName}@`,
    'unrelated',
    './extensions/config-composer/server.ts',
    new URL('../src/config-composer/server.ts', import.meta.url).href,
  ]) {
    await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [spec] }));
    await assert.rejects(loadSnapshot(root), /exactly one/, spec);
  }
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({
      plugin: [packageName, packageRoot],
    }),
  );
  await assert.rejects(loadSnapshot(root), /exactly one/);
});

async function dedicatedFixture(t: TestContext): Promise<string> {
  const root = await fixture(t);
  await mkdir(join(root, 'references'));
  const native = parseConfig(config);
  native.plugin = [[packageName, { configFile: './config-composer.jsonc' }]];
  await writeFile(join(root, 'opencode.jsonc'), `// Native settings stay here.\n${JSON.stringify(native, null, 2)}\n`);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    '// Preserve dedicated comments.\n' +
      JSON.stringify(
        {
          sourceDirectories: { shared: './references' },
          configurationPresets: { shared: { model: 'example/fast', variant: 'medium' } },
          componentGroups: {
            developers: { configuration: { modelRef: 'preset:shared', prompt: { append: ['DEVELOPMENT_GUIDANCE'] } } },
            reviewers: { configuration: { model: 'example/deep', variant: 'high' } },
            'custom-team': {},
            'instructions-only': { configuration: { prompt: { prepend: ['COMMON_GUIDANCE'] } } },
          },
          defaults: { agents: { prompt: { append: ['GLOBAL_GUIDANCE'] } } },
          overrides: {
            agents: { 'nested/pinned': { prompt: { inheritDefaults: false, append: ['PINNED_GUIDANCE'] } } },
          },
          components: { skills: {}, commands: {} },
          profiles: {
            work: {
              layers: ['developers', 'instructions-only', 'reviewers'].map((componentGroup) => ({ componentGroup })),
            },
          },
          activeProfiles: ['work'],
        },
        null,
        2,
      ).replace(
        '"prompt": {',
        '// Keep prompt boundary.\n        "prompt": {\n          // Keep fragment operations.',
      ) +
      '\n',
  );
  return root;
}

test('bare and empty-options registrations edit the default file and reload without losing other plugins', async (t) => {
  const root = await dedicatedFixture(t);
  for (const entry of [packageName, [packageName, {}], [packageName, { reloadToken: 'old' }]]) {
    const native = { plugin: ['other-plugin', entry] };
    await writeFile(join(root, 'opencode.jsonc'), JSON.stringify(native));
    const snapshot = await loadSnapshot(root);
    assert.equal(snapshot.settingsFile.path, join(root, 'config-composer.jsonc'));
    const plan = planChange(snapshot, { kind: 'group', name: 'developers', choice: { model: 'example/new' } });
    assert.equal(plan.edits.length, 1);
    assert.ok(plan.edits.every((edit) => edit.file.path === snapshot.settingsFile.path));
    await reloadConfiguration(snapshot, async (plugins) => {
      assert.equal(plugins[0], 'other-plugin');
      assert.equal((plugins[1] as unknown[])[0], packageName);
      assert.equal(typeof ((plugins[1] as unknown[])[1] as Record<string, unknown>).reloadToken, 'string');
      const text = snapshot.configFile.text;
      await writeFile(
        join(root, 'opencode.jsonc'),
        applyEdits(text, modify(text, ['plugin'], plugins, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
      );
    });
    assert.equal((await loadSnapshot(root)).settingsFile.path, snapshot.settingsFile.path);
  }
});

test('dedicated model edits preserve prompt composition, typed namespaces, comments, and native settings', async (t) => {
  const root = await dedicatedFixture(t);
  const originalNative = await readFile(join(root, 'opencode.jsonc'), 'utf8');
  const originalAgent = await readFile(join(root, 'agents/nested/pinned.md'), 'utf8');
  const before = parseConfig(await readFile(join(root, 'config-composer.jsonc'), 'utf8'));
  const snapshot = await loadSnapshot(root);
  assert.equal(snapshot.settingsFile.path, join(root, 'config-composer.jsonc'));
  await savePlan(planChange(snapshot, { kind: 'group', name: 'developers', choice: { model: 'other/new' } }));
  const after = parseConfig(await readFile(join(root, 'config-composer.jsonc'), 'utf8'));
  assert.deepEqual(after.components, before.components);
  assert.deepEqual(after.sourceDirectories, before.sourceDirectories);
  assert.deepEqual(after.defaults, before.defaults);
  assert.deepEqual(after.overrides, before.overrides);
  assert.equal(after.groups, undefined, 'editor must not create a flat group section');
  assert.equal(after.modelPresets, undefined, 'editor must not create a flat preset section');
  assert.deepEqual((await loadSnapshot(root)).groups.developers, {
    model: 'other/new',
    prompt: { append: ['DEVELOPMENT_GUIDANCE'] },
  });
  assert.match(await readFile(join(root, 'config-composer.jsonc'), 'utf8'), /Preserve dedicated comments/);
  assert.match(await readFile(join(root, 'config-composer.jsonc'), 'utf8'), /Keep fragment operations/);
  assert.match(await readFile(join(root, 'config-composer.jsonc'), 'utf8'), /Keep prompt boundary/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), originalNative);
  assert.equal(await readFile(join(root, 'agents/nested/pinned.md'), 'utf8'), originalAgent);
});

test('membership edits store ordered arrays and preserve pins and prompts', async (t) => {
  const root = await dedicatedFixture(t);
  await savePlan(
    planChange(await loadSnapshot(root), {
      kind: 'membership',
      agent: 'nested/pinned',
      groups: ['developers', 'instructions-only', 'reviewers'],
    }),
  );
  let snapshot = await loadSnapshot(root);
  let agent = snapshot.agents.find((agent) => agent.name === 'nested/pinned')!;
  assert.deepEqual(agentGroups(agent.settings), ['developers', 'instructions-only', 'reviewers']);
  assert.equal(agent.settings.model, 'example/exception');
  assert.ok((await readFile(join(root, 'agents/nested/pinned.md'), 'utf8')).endsWith(prompt));
  await savePlan(planChange(snapshot, { kind: 'override', agent: 'nested/pinned', choice: {} }));
  snapshot = await loadSnapshot(root);
  agent = snapshot.agents.find((agent) => agent.name === 'nested/pinned')!;
  assert.equal(snapshot.resolved.choices[agent.name].model, 'example/deep');
  assert.equal(snapshot.resolved.choices[agent.name].variant, 'high');
  await savePlan(
    planChange(snapshot, {
      kind: 'membership',
      agent: 'nested/pinned',
      groups: ['reviewers', 'developers', 'instructions-only'],
    }),
  );
  snapshot = await loadSnapshot(root);
  agent = snapshot.agents.find((agent) => agent.name === 'nested/pinned')!;
  const effective = snapshot.resolved.choices[agent.name];
  assert.equal(
    effective.model,
    'example/deep',
    'active profile order controls precedence independently of membership order',
  );
  assert.equal(effective.variant, 'high');
  await assert.rejects(
    savePlan(planChange(snapshot, { kind: 'membership', agent: 'nested/pinned', groups: [] })),
    /must be selected before applying an override/,
  );
});

test('dedicated settings edits reject stale files and reload preserves concurrent dedicated comments', async (t) => {
  const root = await dedicatedFixture(t);
  const path = join(root, 'config-composer.jsonc');
  const snapshot = await loadSnapshot(root);
  const plan = planChange(snapshot, { kind: 'preset', name: 'shared', choice: { model: 'other/new' } });
  await writeFile(path, (await readFile(path, 'utf8')) + '\n// External dedicated edit\n');
  await assert.rejects(savePlan(plan), /Settings changed/);
  assert.match(await readFile(path, 'utf8'), /External dedicated edit/);
  await assert.rejects(
    reloadConfiguration(await loadSnapshot(root), async (plugin) => {
      const nativePath = join(root, 'opencode.jsonc');
      const native = await readFile(nativePath, 'utf8');
      await writeFile(nativePath, applyEdits(native, modify(native, ['plugin'], plugin, {})));
      await writeFile(path, (await readFile(path, 'utf8')) + '\n// Concurrent reload edit\n');
    }),
    /Settings changed during reload/,
  );
  assert.match(await readFile(path, 'utf8'), /Concurrent reload edit/);
});

test('removing a sole model reference preserves adjacent comments and accepts its trailing comma', async (t) => {
  const root = await dedicatedFixture(t);
  const path = join(root, 'config-composer.jsonc');
  const before = await readFile(path, 'utf8');
  await writeFile(
    path,
    before.replace(
      '"reviewers": {',
      '"sole": {"configuration": {\n        // Keep the leading comment.\n        "modelRef": "preset:shared",\n        // Keep the trailing comment.\n      }},\n      "reviewers": {',
    ),
  );
  await savePlan(planChange(await loadSnapshot(root), { kind: 'group', name: 'sole', choice: {} }));
  assert.deepEqual((await loadSnapshot(root)).groups.sole, {});
  const after = await readFile(path, 'utf8');
  assert.match(after, /Keep the leading comment/);
  assert.match(after, /Keep the trailing comment/);
});

test('defaults honor pins, variant overrides, unknown groups, and disabled agents', () => {
  const agents: Record<string, AgentSettings> = {
    inherited: { options: { groups: ['developers'] } },
    override: { groups: ['developers'], model: 'other/model' },
    variant: { groups: ['developers'], variant: 'low' },
    discovered: { groups: [] },
    ungrouped: {},
    disabled: { disable: true, groups: ['INVALID'] },
  };
  applyDefaults(agents, groups);
  assert.equal(agents.inherited.model, 'example/fast');
  assert.equal(agents.inherited.variant, 'medium');
  assert.equal(agents.override.variant, undefined, 'do not pass a group variant to another model');
  assert.equal(agents.variant.variant, 'low');
  for (const name of ['discovered', 'ungrouped', 'disabled']) {
    assert.equal(agents[name].model, undefined);
  }
  assert.deepEqual(agents.inherited.options, { groups: ['developers'] }, 'keep metadata for agent discovery');
  const invalid = { good: { groups: ['developers'] }, bad: { groups: ['invalid/group'] } };
  assert.throws(() => applyDefaults(invalid, groups));
  assert.equal((invalid.good as AgentSettings).model, undefined, 'validate before mutating');
});

test('provider catalog exposes configured models and supported variants', () => {
  const models = catalogModels([
    {
      id: 'example',
      name: 'Example',
      models: {
        fast: { name: 'Fast', variants: { low: { reasoningEffort: 'low' }, hidden: { disabled: true } } },
        old: { status: 'deprecated' },
      },
    },
  ]);
  assert.deepEqual(
    models.map((model) => model.id),
    ['example/fast'],
  );
  assert.deepEqual(Object.keys(models[0].variants), ['low']);
  assert.equal(validateChoice({ model: 'example/fast', variant: 'low' }, models)?.id, 'example/fast');
  assert.throws(() => validateChoice({ model: 'example/fast', variant: 'high' }, models));
  assert.throws(() => validateChoice({ model: 'missing/model' }, models));
  assert.throws(() => catalogModels(undefined));
  for (const options of [
    { groups: { developers: { variant: 'high' } } },
    { groups: { '../bad': {} } },
    { groups: { developers: { model: 'bad' } } },
    { other: {} },
  ]) {
    assert.throws(() => readSettings({ agent: options }).groups);
  }
  assert.deepEqual(readSettings({ agent: { groups } }).groups, groups);
});

test('server hook strips group metadata and aligns built-in variant fallbacks', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: { developers: { configuration: groups.developers } },
      profiles: { work: { layers: [{ componentGroup: 'developers' }] } },
      activeProfiles: ['work'],
    }),
  );
  const hooks = await server.server({} as PluginInput, { configFile: join(root, 'config-composer.jsonc') });
  const config = {
    agent: {
      title: { options: { groups: ['developers'], reasoningEffort: 'old' } },
      compaction: {
        model: 'example/fast',
        variant: 'medium',
        options: { groups: ['developers'], reasoningEffort: 'old' },
      },
    },
  };
  await hooks.config!(config);
  assert.equal((config.agent.title as AgentSettings).model, 'example/fast');
  const hook = hooks['chat.params']!;
  type Params = Parameters<NonNullable<Hooks['chat.params']>>;
  for (const agent of ['worker', 'title', 'compaction']) {
    const model: Record<string, unknown> = {
      providerID: 'example',
      id: 'fast',
      variants: { medium: { reasoningEffort: 'medium' } },
    };
    const input = { agent, model } as unknown as Params[0];
    const output = {
      options: { groups: ['developers'], reasoningEffort: 'old', unrelated: true },
    } as unknown as Params[1];
    await hook(input, output);
    assert.equal(output.options.groups, undefined);
    assert.equal(output.options.unrelated, true);
    assert.equal(output.options.reasoningEffort, agent === 'worker' ? 'old' : 'medium');
    if (agent !== 'worker') {
      model.variants = {};
      if (agent === 'title') {
        await assert.rejects(hook(input, output), /does not support/, 'reject unsupported inherited group variants');
      } else {
        await hook(input, output);
        assert.equal(
          output.options.reasoningEffort,
          undefined,
          'remove stale pinned fallback on models without that variant',
        );
      }
    }
  }
  assert.deepEqual(config.agent.title.options.groups, ['developers']);
  const input = {
    agent: 'compaction',
    message: { variant: 'high' },
    model: {
      providerID: 'example',
      id: 'fast',
      variants: { medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' } },
    },
  } as unknown as Params[0];
  const output = { options: { reasoningEffort: 'high' } } as unknown as Params[1];
  await hook(input, output);
  assert.equal(output.options.reasoningEffort, 'high', 'keep a supported request variant during compaction');
});

test('group saves preserve JSONC settings, discover new groups, and retain pins', async (t) => {
  const root = await fixture(t);
  let snapshot = await loadSnapshot(root);
  assert.deepEqual(groupNames(snapshot), ['custom-team', 'developers', 'reviewers']);
  assert.ok(!snapshot.agents.some((agent) => agent.name === 'disabled'));
  const originalAgent = await readFile(join(root, 'agents/nested/pinned.md'), 'utf8');
  const plan = planChange(snapshot, { kind: 'all', choice: { model: 'other/new', variant: 'low' } });
  assert.equal(await readFile(snapshot.configFile.path, 'utf8'), config, 'planning must not write');
  await savePlan(plan);
  snapshot = await loadSnapshot(root);
  assert.match(snapshot.configFile.text, /Keep this comment and trailing comma/);
  assert.deepEqual(snapshot.config.permission, { edit: 'ask' });
  assert.equal(snapshot.config.model, 'other/new');
  assert.equal(snapshot.config.small_model, 'other/new');
  assert.deepEqual(snapshot.groups['custom-team'], { model: 'other/new', variant: 'low' });
  assert.equal(await readFile(join(root, 'agents/nested/pinned.md'), 'utf8'), originalAgent);
  assert.equal(
    resolveChoice(snapshot.agents.find((a) => a.name === 'nested/pinned')!.settings, snapshot.groups).model,
    'example/exception',
  );
  assert.equal(
    resolveChoice(snapshot.agents.find((a) => a.name === 'builtin')!.settings, snapshot.groups).model,
    'other/new',
  );
});

test('moving and unpinning Markdown agents preserves prompts, YAML comments, and lower-layer permissions', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'agents/nested/pinned.md');
  await writeFile(path, pinned.replaceAll('\n', '\r\n'));
  await savePlan(
    planChange(await loadSnapshot(root), { kind: 'membership', agent: 'nested/pinned', groups: ['new-team'] }),
  );
  const moved = await readFile(path, 'utf8');
  assert.ok(moved.endsWith(prompt.replaceAll('\n', '\r\n')));
  assert.match(moved, /description: 'Keep my quotes' # and this comment/);
  assert.match(moved, /model: example\/exception/);
  assert.ok(!/(?<!\r)\n/.test(moved), 'preserve CRLF');
  await savePlan(planChange(await loadSnapshot(root), { kind: 'override', agent: 'nested/pinned', choice: {} }));
  const snapshot = await loadSnapshot(root);
  const agent = snapshot.agents.find((agent) => agent.name === 'nested/pinned')!;
  assert.equal(agent.settings.model, undefined);
  assert.equal(agent.settings.variant, undefined);
  assert.deepEqual(agent.settings.permission, { edit: 'deny' });
  assert.equal(resolveChoice(agent.settings, snapshot.groups).source, 'native');
  await savePlan(planChange(snapshot, { kind: 'membership', agent: 'nested/pinned', groups: [] }));
  assert.deepEqual((await loadSnapshot(root)).agents.find((a) => a.name === 'nested/pinned')!.settings.groups, []);
  assert.ok((await readFile(path, 'utf8')).endsWith(prompt.replaceAll('\n', '\r\n')));
});

test('saving preserves configuration and agent file modes under a restrictive umask', async (t) => {
  const root = await fixture(t);
  const configPath = join(root, 'opencode.jsonc');
  const agentPath = join(root, 'agents/nested/pinned.md');
  await chmod(configPath, 0o664);
  await chmod(agentPath, 0o600);
  const originalUmask = process.umask(0o077);
  try {
    await savePlan(planChange(await loadSnapshot(root), { kind: 'override', agent: 'nested/pinned', choice: {} }));
    assert.equal((await stat(configPath)).mode & 0o777, 0o664);
    assert.equal((await stat(agentPath)).mode & 0o777, 0o600);
    assert.equal(
      (await loadSnapshot(root)).agents.find((agent) => agent.name === 'nested/pinned')!.settings.model,
      undefined,
    );
  } finally {
    process.umask(originalUmask);
  }
});

test('stale snapshots and locked files cannot overwrite other edits', async (t) => {
  const root = await fixture(t);
  const plan = planChange(await loadSnapshot(root), {
    kind: 'group',
    name: 'developers',
    choice: { model: 'other/new' },
  });
  await writeFile(join(root, 'opencode.jsonc'), config + '\n// External edit\n');
  await assert.rejects(savePlan(plan), /Settings changed/);
  assert.match(await readFile(join(root, 'opencode.jsonc'), 'utf8'), /External edit/);
  const fresh = planChange(await loadSnapshot(root), { kind: 'group', name: 'developers', choice: {} });
  await writeFile(join(root, 'agents/extra.md'), `---\ngroups: [developers]\n${prompt}`);
  await assert.rejects(savePlan(fresh), /agent list changed/);
  await writeFile(join(root, '.config-composer.lock'), '');
  await assert.rejects(savePlan(fresh), /Another settings edit/);
  assert.ok(!(await readdir(root)).some((name) => name.endsWith('.tmp')));
});

test('invalid, duplicate, and ambiguous files fail without writes', async (t) => {
  const root = await fixture(t);
  for (const bad of ['{"x":1,"x":2}', '{"broken":']) {
    assert.throws(() => parseConfig(bad));
  }
  await writeFile(join(root, 'agents/new.md'), `---\ngroups: [a]\ngroups: [b]\n${prompt}`);
  await assert.rejects(loadSnapshot(root), /invalid agent frontmatter/);
  await rm(join(root, 'agents/new.md'));
  await symlink(join(root, 'agents/nested/pinned.md'), join(root, 'agents/link.md'));
  await assert.rejects(loadSnapshot(root), /symlinks/);
  await rm(join(root, 'agents/link.md'));
  await writeFile(join(root, 'opencode.json'), '{}');
  await assert.rejects(loadSnapshot(root), /one opencode.json/);
  await rm(join(root, 'opencode.json'));
  await writeFile(join(root, 'config.json'), '{}');
  await assert.rejects(loadSnapshot(root), /Merge legacy config.json/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), config);
});

test('a later file failure rolls back earlier edits and removes temporary files', async (t) => {
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  const plan = planChange(snapshot, { kind: 'override', agent: 'nested/pinned', choice: {} });
  assert.equal(plan.edits.length, 2);
  // Force a real filesystem failure at the second write without changing the first file's write behavior.
  plan.edits[1] = { ...plan.edits[1], file: { ...plan.edits[1].file, path: join(root, 'missing', 'config.jsonc') } };
  await assert.rejects(savePlan(plan), /ENOENT/);
  assert.equal(await readFile(join(root, 'agents/nested/pinned.md'), 'utf8'), pinned);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), config);
  assert.ok(!(await readdir(root)).some((name) => name === '.config-composer.lock' || name.endsWith('.tmp')));
});

test('reload does not overwrite a concurrent comment edit', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'opencode.jsonc');
  await assert.rejects(
    reloadConfiguration(await loadSnapshot(root), async (plugin) => {
      const before = await readFile(path, 'utf8');
      await writeFile(
        path,
        applyEdits(
          before,
          modify(before, ['plugin'], plugin, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
        ) + "\n// Another editor's comment\n",
      );
    }),
    /Settings changed during reload/,
  );
  assert.match(await readFile(path, 'utf8'), /Another editor's comment/);
});

function uiHarness(root: string, globalDirectory = root, serverDirectory = root) {
  // Host callbacks are typed void, but the harness must await their asynchronous implementations.
  type SelectDialog = Omit<TuiDialogSelectProps<string>, 'onSelect'> & {
    onSelect?: (...args: Parameters<NonNullable<TuiDialogSelectProps<string>['onSelect']>>) => void | Promise<void>;
  };
  type ConfirmDialog = Omit<TuiDialogConfirmProps, 'onConfirm' | 'onCancel'> & {
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void | Promise<void>;
  };
  type PromptDialog = Omit<TuiDialogPromptProps, 'onConfirm'> & {
    onConfirm?: (value: string) => void | Promise<void>;
  };
  let dialog: SelectDialog | ConfirmDialog | PromptDialog | TuiDialogAlertProps | undefined;
  let onClose: (() => void) | undefined;
  const clear = () => {
    onClose?.();
    onClose = undefined;
    dialog = undefined;
  };
  let frozenConfig: unknown;
  let providerError = false;
  let projectProofError = false;
  let providerGate: (() => Promise<void>) | undefined;
  let proofGate: (() => Promise<void>) | undefined;
  let configGate: (() => Promise<void>) | undefined;
  const controller = new AbortController();
  let active = false;
  let updates = 0;
  let globalUpdates = 0;
  let serverRoot = root;
  let unregistered = false;
  let dispose: (() => void) | undefined;
  const commands: { name: string; slashName?: string; slashAliases?: string[]; run: () => void | Promise<void> }[] = [];
  const toasts: { message: string }[] = [];
  const keymapListeners = new Set<() => void>();
  let nativeCommands: string[] = [];
  const api = {
    state: {
      path: {
        config: serverDirectory,
        directory: undefined as string | undefined,
        worktree: undefined as string | undefined,
      },
    },
    route: { current: { name: 'home' } },
    lifecycle: {
      signal: controller.signal,
      onDispose: (callback: () => void) => {
        dispose = callback;
      },
    },
    keymap: {
      getCommands: () => commands,
      on: (_event: string, handler: () => void) => {
        keymapListeners.add(handler);
        return () => keymapListeners.delete(handler);
      },
      registerLayer: (layer: { commands: typeof commands }) => {
        commands.push(...layer.commands);
        keymapListeners.forEach((handler) => handler());
        return () => {
          unregistered = true;
          for (const command of layer.commands) {
            const index = commands.indexOf(command);
            if (index >= 0) {
              commands.splice(index, 1);
            }
          }
          keymapListeners.forEach((handler) => handler());
        };
      },
    },
    ui: {
      DialogSelect: (props: SelectDialog) => {
        dialog = props;
      },
      DialogAlert: (props: TuiDialogAlertProps) => {
        dialog = props;
      },
      DialogConfirm: (props: ConfirmDialog) => {
        dialog = props;
      },
      DialogPrompt: (props: PromptDialog) => {
        dialog = props;
      },
      dialog: {
        setSize: () => {},
        get open() {
          return dialog !== undefined;
        },
        replace: (render: () => void, closed?: () => void) => {
          onClose?.();
          onClose = closed;
          render();
        },
        clear,
      },
      toast: (toast: { message: string }) => {
        toasts.push(toast);
      },
    },
    client: {
      command: { list: async () => ({ data: nativeCommands.map((name) => ({ name })) }) },
      file: {
        read: async (input: { path: string; directory: string }) => {
          await proofGate?.();
          if (projectProofError && input.directory === api.state.path.directory) {
            throw new Error('Project proof failed');
          }
          return {
            data: {
              type: 'text',
              content: await readFile(join(serverRoot, relative(root, input.directory), input.path), 'utf8'),
            },
          };
        },
      },
      config: {
        get: async () => {
          await configGate?.();
          if (frozenConfig !== undefined) {
            return { data: frozenConfig };
          }
          const path = api.state.path as { worktree?: string; directory?: string };
          const workspace =
            typeof path.worktree === 'string' && path.worktree !== '' && path.worktree !== '/'
              ? path.worktree
              : (path.directory ?? root);
          return {
            data: await editorServerConfig(
              root,
              { model: 'example/fast' },
              workspace,
              path.directory ?? workspace,
              path.worktree ?? workspace,
            ),
          };
        },
        providers: async () => {
          await providerGate?.();
          return providerError
            ? { error: {} }
            : {
                data: {
                  providers: [
                    {
                      id: 'example',
                      models: {
                        next: { name: 'Next', variants: { low: {} } },
                        fast: { name: 'Fast', variants: { low: {}, medium: {} } },
                        deep: { name: 'Deep', variants: { high: {} } },
                      },
                    },
                  ],
                },
              };
        },
      },
      session: { status: async () => ({ data: active ? { session: { type: 'busy' } } : {} }) },
      instance: {
        dispose: async () => {
          updates++;
          frozenConfig = undefined;
          return { data: true };
        },
      },
      app: { agents: async () => ({ data: [] }) },
      global: {
        config: {
          update: async (input: { config: { plugin: unknown[] } }) => {
            updates++;
            globalUpdates++;
            frozenConfig = undefined;
            const path = join(serverRoot, 'opencode.jsonc');
            const before = await readFile(path, 'utf8');
            await writeFile(
              path,
              applyEdits(
                before,
                modify(before, ['plugin'], input.config.plugin, {
                  formattingOptions: { insertSpaces: true, tabSize: 2 },
                }),
              ),
            );
            return { data: {} };
          },
        },
      },
    },
  } as unknown as TuiPluginApi;
  const settings = registerSettings(api, root, globalDirectory);
  return {
    api,
    refreshShortcuts: settings.refreshShortcuts,
    commandNames: () => commands.map((command) => command.name),
    setNativeCommands: (names: string[]) => {
      nativeCommands = names;
    },
    async freezeServer() {
      frozenConfig = (await api.client.config.get()).data;
    },
    controller,
    delayProofAfter(skip: number) {
      const requested = Promise.withResolvers<undefined>();
      const response = Promise.withResolvers<undefined>();
      proofGate = () => {
        if (skip-- > 0) {
          return Promise.resolve();
        }
        requested.resolve(undefined);
        return response.promise;
      };
      return { requested: requested.promise, resolve: () => response.resolve(undefined) };
    },
    delayProviders() {
      const requested = Promise.withResolvers<undefined>();
      const response = Promise.withResolvers<undefined>();
      providerGate = () => {
        requested.resolve(undefined);
        return response.promise;
      };
      return { requested: requested.promise, resolve: () => response.resolve(undefined) };
    },
    delayConfig() {
      const requested = Promise.withResolvers<undefined>();
      const response = Promise.withResolvers<undefined>();
      configGate = () => {
        requested.resolve(undefined);
        return response.promise;
      };
      return { requested: requested.promise, resolve: () => response.resolve(undefined) };
    },
    get dialog() {
      return dialog;
    },
    title: () => dialog?.title,
    message: () => (dialog !== undefined && 'message' in dialog ? dialog.message : ''),
    get toasts() {
      return toasts;
    },
    get updates() {
      return updates;
    },
    get globalUpdates() {
      return globalUpdates;
    },
    setProject(value: string) {
      api.state.path.directory = value;
      api.state.path.worktree = value;
    },
    setProjectProofError(value: boolean) {
      projectProofError = value;
    },
    setProviderError(value: boolean) {
      providerError = value;
    },
    setServerRoot(value: string) {
      serverRoot = value;
    },
    setActive(value: boolean) {
      active = value;
    },
    async command(name = 'config-composer.models') {
      await commands.find((c) => c.name === name)!.run();
    },
    async select(value: string) {
      assert.ok(dialog !== undefined && 'options' in dialog);
      const option = dialog.options.find((item) => item.value === value);
      assert.ok(option !== undefined, `${dialog.title}: missing ${value}`);
      await dialog.onSelect!(option);
    },
    async confirm() {
      const pending = (dialog as ConfirmDialog).onConfirm?.();
      clear();
      await pending;
    },
    async cancel() {
      const pending = (dialog as ConfirmDialog).onCancel?.();
      clear();
      await pending;
    },
    async escape() {
      clear();
      await Promise.resolve();
    },
    async enter(value: string) {
      await (dialog as PromptDialog).onConfirm!(value);
    },
    dispose() {
      dispose!();
      assert.ok(unregistered);
    },
  };
}

for (const change of ['escape', 'close', 'back', 'dialog', 'route', 'session', 'client', 'abort'] as const) {
  test(`a delayed model picker does not replace the dialog after ${change}`, async (t) => {
    const root = await fixture(t);
    const ui = uiHarness(root);
    Object.assign(ui.api.route, { current: { name: 'session', params: { sessionID: 'first' } } });
    await ui.command();
    await ui.select('+global');
    const response = ui.delayProviders();
    const pending = ui.select('model');
    await response.requested;
    if (change === 'escape') {
      await ui.escape();
    } else if (change === 'close') {
      await ui.escape();
      await ui.escape();
    } else if (change === 'back') {
      await ui.select('\u0000back');
    } else if (change === 'dialog') {
      ui.api.ui.dialog.replace(() => ui.api.ui.DialogSelect({ title: 'Other dialog', options: [] }));
    } else if (change === 'route') {
      Object.assign(ui.api.route, { current: { name: 'home' } });
    } else if (change === 'session' && ui.api.route.current.name === 'session') {
      ui.api.route.current.params!.sessionID = 'second';
    } else if (change === 'client') {
      Object.assign(ui.api, { client: {} });
    } else if (change === 'abort') {
      ui.controller.abort();
    }
    const current = ui.dialog;
    response.resolve();
    await pending;
    await Promise.resolve();
    assert.equal(ui.dialog, current, 'a stale provider response must leave the current dialog alone');
    assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), config);
  });
}

test('a delayed reference picker does not reopen after Escape', async (t) => {
  const ui = uiHarness(await fixture(t));
  await ui.command();
  await ui.select('developers');
  const response = ui.delayProviders();
  const pending = ui.select('opencode:model');
  await response.requested;
  await ui.escape();
  const current = ui.dialog;
  response.resolve();
  await pending;
  assert.equal(ui.dialog, current);
});

test('reload alias opens the same instance-scoped revision apply path', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.command('config-composer.reload');
  assert.equal(ui.title(), 'Settings saved');
  await ui.select('reload');
  assert.match(ui.message(), /only this instance/i);
  assert.ok(ui.message().includes(root));
  assert.ok(!ui.message().includes('ALL workspaces'));
});

test('TUI model selection previews, saves, and blocks reload while an agent runs', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.freezeServer();
  await ui.command();
  await ui.select('developers');
  await ui.select('example/next');
  await ui.select('low');
  assert.equal(ui.dialog?.title, 'Save agent settings?');
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), config);
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root)).groups.developers, { model: 'example/next', variant: 'low' });
  assert.match(JSON.stringify(ui.dialog), /Saved Composer revision .* pending/);
  ui.setActive(true);
  await ui.select('reload');
  await ui.confirm();
  assert.equal(ui.updates, 0);
  assert.match(ui.toasts.at(-1)!.message, /still running/);
  assert.match(JSON.stringify(ui.dialog), /Apply failed/);
  ui.setActive(false);
  await ui.select('reload');
  await ui.confirm();
  assert.equal(ui.updates, 1);
  assert.equal(ui.globalUpdates, 0, 'scoped apply must not call the global configuration update API');
  assert.match(await readFile(join(root, 'opencode.jsonc'), 'utf8'), /Keep this comment and trailing comma/);
  ui.dispose();
});

for (const scope of ['global', 'all'] as const) {
  test(`native ${scope} model saves require restart and never report a Composer apply`, async (t) => {
    const root = await fixture(t);
    const ui = uiHarness(root);
    await ui.freezeServer();
    await ui.command();
    await ui.select(scope === 'global' ? '+global' : '+all');
    if (scope === 'global') {
      await ui.select('model');
    }
    await ui.select('example/next');
    if (scope === 'all') {
      await ui.select('low');
    }
    await ui.confirm();
    assert.equal(ui.title(), 'Native settings saved');
    assert.match(JSON.stringify(ui.dialog), /Restart OpenCode to apply native settings/);
    assert.match(await readFile(join(root, 'opencode.jsonc'), 'utf8'), /example\/next/);
    assert.equal(ui.updates, 0);
    assert.equal(ui.globalUpdates, 0);
    assert.ok(ui.toasts.every((toast) => !toast.message.includes('Applied')));
  });
}

test('a failed save remains distinct from pending or applied state and retains disk bytes', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  const source = join(root, 'config-composer.jsonc');
  const before = await readFile(source, 'utf8');
  await ui.command();
  await ui.select('developers');
  await ui.select('example/next');
  await ui.select('low');
  const lock = join(root, '.config-composer.lock');
  await writeFile(lock, 'Another editor holds this lock');
  await ui.confirm();
  assert.equal(await readFile(source, 'utf8'), before);
  await rm(lock);
  await ui.command('config-composer.reload');
  assert.match(JSON.stringify(ui.dialog), /Save failed/);
  assert.equal(ui.updates, 0);
});

test('TUI cancellation and provider failures leave files unchanged', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.command();
  ui.setProviderError(true);
  await ui.select('developers');
  assert.match(ui.toasts.at(-1)!.message, /Could not load provider models/);
  ui.setProviderError(false);
  await ui.select('developers');
  await ui.select('example/next');
  await ui.select('');
  await ui.cancel();
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), config);
  await ui.command();
  await ui.select('+all');
  await ui.select('example/next');
  await ui.select('low');
  ui.setProviderError(true);
  await ui.confirm();
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), config);
  assert.equal(ui.updates, 0);
});

test('a custom configuration installation applies its instance without writing global configuration', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root, join(root, 'different-global-directory'));
  await ui.command();
  await ui.select('+reload');
  await ui.select('reload');
  await ui.confirm();
  assert.equal(ui.updates, 1);
  assert.equal(ui.globalUpdates, 0);
  assert.match(ui.toasts.at(-1)!.message, /Applied/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), config);
});

for (const change of ['instance', 'sources'] as const) {
  test(`apply confirmation rejects a changed ${change} instead of applying an unreviewed target`, async (t) => {
    const root = await fixture(t);
    const ui = uiHarness(root);
    await ui.command();
    await ui.select('+reload');
    await ui.select('reload');
    if (change === 'instance') {
      const other = join(root, 'other');
      await mkdir(other);
      ui.setProject(other);
    } else {
      const path = join(root, 'config-composer.jsonc');
      await writeFile(path, (await readFile(path, 'utf8')) + '\n// Saved while confirmation was open');
    }
    await ui.confirm();
    assert.equal(ui.updates, 0);
    assert.match(ui.toasts.at(-1)!.message, /changed|Reopen/i);
  });
}

test('reload preserves an unrelated plugin edited while the final filesystem proof is pending', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.command();
  await ui.select('+reload');
  await ui.select('reload');
  const proof = ui.delayProofAfter(0); // Pause confirmation's final filesystem proof.
  const pending = ui.confirm();
  await proof.requested;
  const path = join(root, 'opencode.jsonc');
  const current = await readFile(path, 'utf8');
  const changed = applyEdits(current, modify(current, ['plugin', -1], 'concurrent-plugin', {}));
  await writeFile(path, changed);
  proof.resolve();
  await pending;
  assert.equal(await readFile(path, 'utf8'), changed);
  assert.equal(ui.updates, 0);
  assert.match(ui.toasts.at(-1)!.message, /configuration changed|Settings changed/);
});

for (const boundary of ['open', 'save', 'reload'] as const) {
  test(`identical advertised paths on separate filesystems cannot ${boundary} local settings or update remote plugins`, async (t) => {
    const root = await fixture(t);
    const remote = await fixture(t);
    const remoteText = JSON.stringify({ plugin: ['remote-only-plugin'], model: 'remote/model' });
    await writeFile(join(remote, 'opencode.jsonc'), remoteText);
    const ui = uiHarness(root);
    if (boundary === 'open') {
      ui.setServerRoot(remote);
    }
    await ui.command();
    if (boundary === 'open') {
      assert.equal(ui.dialog, undefined, 'matching path strings must not authorize editing');
    } else if (boundary === 'save') {
      await ui.select('+all');
      await ui.select('example/next');
      await ui.select('low');
      ui.setServerRoot(remote);
      await ui.confirm();
    } else {
      await ui.select('+reload');
      await ui.select('reload');
      ui.setServerRoot(remote);
      await ui.confirm();
    }
    assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), config);
    assert.equal(await readFile(join(remote, 'opencode.jsonc'), 'utf8'), remoteText);
    assert.equal(ui.updates, 0);
    assert.match(ui.toasts.at(-1)!.message, /shared filesystem/);
    assert.ok(!(await readdir(root)).some((name) => name.startsWith('.config-composer-probe-')));
  });
}

test('TUI opens and saves the selected custom directory when the server reports its default config path', async (t) => {
  const root = await fixture(t);
  const globalDirectory = join(root, 'global');
  await mkdir(globalDirectory);
  const previous = process.env.OPENCODE_CONFIG_DIR;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previous;
    }
  });
  process.env.OPENCODE_CONFIG_DIR = root;
  const ui = uiHarness(root, globalDirectory, globalDirectory);
  await ui.command('config-composer.membership');
  assert.equal(ui.dialog?.title, 'Agent groups');
  await ui.select('+');
  await ui.enter('custom-install-group');
  await ui.confirm();
  assert.ok(groupNames(await loadSnapshot(root)).includes('custom-install-group'));
  assert.deepEqual(await readdir(globalDirectory), []);
  await ui.select('reload');
  await ui.confirm();
  assert.equal(ui.updates, 1);
  assert.equal(ui.globalUpdates, 0);
  assert.deepEqual(await readdir(globalDirectory), []);
});

test('TUI rejects an installation that is neither the server config nor the selected custom directory', async (t) => {
  const root = await fixture(t);
  const globalDirectory = join(root, 'global');
  await mkdir(globalDirectory);
  const ui = uiHarness(root, globalDirectory, globalDirectory);
  await ui.command();
  assert.equal(ui.dialog, undefined);
  assert.match(ui.toasts.at(-1)!.message, /configuration directory/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), config);
});

test('TUI Back and Escape preserve parents and cancel changes without saving', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.command('config-composer.membership');
  await ui.select('developers');
  await ui.select('+model');
  await ui.select('example/next');
  await ui.select('low');
  await ui.cancel();
  assert.equal(ui.dialog?.title, 'Next: variant');
  await ui.select('\u0000back');
  assert.notEqual(ui.dialog, undefined);
  assert.equal(ui.dialog.title, 'Group: developers · model source');
  await ui.escape();
  assert.notEqual(ui.dialog, undefined);
  assert.equal(ui.dialog.title, 'Group: developers');
  await ui.escape();
  assert.notEqual(ui.dialog, undefined);
  assert.equal(ui.dialog.title, 'Agent groups');
  assert.equal((ui.dialog as TuiDialogSelectProps<string>).current, 'developers');
  await ui.select('+');
  await ui.enter('cancelled-group');
  await ui.escape();
  assert.notEqual(ui.dialog, undefined);
  assert.equal(ui.dialog.title, 'New agent group');
  assert.equal((ui.dialog as TuiDialogPromptProps).value, 'cancelled-group');
  await ui.escape();
  assert.notEqual(ui.dialog, undefined);
  assert.equal(ui.dialog.title, 'Agent groups');
  await ui.escape();
  assert.equal(ui.dialog, undefined);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), config);
});

test('TUI can create a group by reassigning an agent and return it to inherited defaults', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.command('config-composer.membership');
  await ui.select('+');
  await ui.enter('new-team');
  await ui.confirm();
  await ui.select('later');
  await ui.command('config-composer.membership');
  await ui.select('+agents');
  await ui.select('nested/pinned');
  await ui.select('group');
  await ui.select('+clear');
  await ui.select('+add');
  await ui.select('new-team');
  await ui.select('+save');
  await ui.confirm();
  await ui.select('later');
  await ui.command('config-composer.membership');
  await ui.select('new-team');
  await ui.select('nested/pinned');
  await ui.select('inherit');
  await ui.confirm();
  const snapshot = await loadSnapshot(root);
  const agent = snapshot.agents.find((agent) => agent.name === 'nested/pinned')!;
  assert.deepEqual(agent.settings.groups, ['new-team']);
  assert.equal(agent.settings.model, undefined);
  assert.equal(resolveChoice(agent.settings, snapshot.groups).source, 'native');
});

test('TUI adds, reorders, and removes memberships with a resolved preview and preserves prompt settings', async (t) => {
  const root = await dedicatedFixture(t);
  await writeFile(join(root, 'agents/new.md'), `---\ngroups: [developers]\n${prompt}`);
  const original = parseConfig(await readFile(join(root, 'config-composer.jsonc'), 'utf8'));
  const ui = uiHarness(root);
  await ui.command('config-composer.membership');
  await ui.select('+agents');
  await ui.select('new');
  await ui.select('group');
  await ui.select('+add');
  await ui.select('reviewers');
  assert.ok(ui.dialog !== undefined && 'options' in ui.dialog);
  assert.match(ui.dialog.options.find((option) => option.value === '+save')!.description!, /profile layer order/);
  await ui.select('reviewers');
  await ui.select('earlier');
  assert.match(ui.dialog.options.find((option) => option.value === '+save')!.description!, /profile layer order/);
  await ui.select('developers');
  await ui.select('remove');
  await ui.select('+save');
  await ui.confirm();
  const current = await loadSnapshot(root);
  assert.deepEqual(current.agents.find((agent) => agent.name === 'new')!.settings.groups, ['reviewers']);
  assert.deepEqual(parseConfig(await readFile(join(root, 'config-composer.jsonc'), 'utf8')), original);
  assert.ok((await readFile(join(root, 'agents/new.md'), 'utf8')).endsWith(prompt));
});

test('TUI model edits save to the dedicated file while retaining shared prompt operations', async (t) => {
  const root = await dedicatedFixture(t);
  const originalNative = await readFile(join(root, 'opencode.jsonc'), 'utf8');
  const original = parseConfig(await readFile(join(root, 'config-composer.jsonc'), 'utf8'));
  const ui = uiHarness(root);
  await ui.command();
  await ui.select('developers');
  await ui.select('example/next');
  await ui.select('low');
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), originalNative);
  await ui.confirm();
  const snapshot = await loadSnapshot(root);
  assert.deepEqual(snapshot.groups.developers, {
    model: 'example/next',
    variant: 'low',
    prompt: { append: ['DEVELOPMENT_GUIDANCE'] },
  });
  const saved = parseConfig(await readFile(join(root, 'config-composer.jsonc'), 'utf8'));
  assert.deepEqual(saved.defaults, original.defaults);
  assert.deepEqual(saved.overrides, original.overrides);
  assert.deepEqual(saved.sourceDirectories, original.sourceDirectories);
  assert.match(await readFile(join(root, 'config-composer.jsonc'), 'utf8'), /Keep fragment operations/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), originalNative);
});

test('TUI membership mutations keep Back and Escape on live parent menus without saving cancelled edits', async (t) => {
  const root = await dedicatedFixture(t);
  const path = join(root, 'agents/new.md');
  const original = `---\ngroups: [developers]\n${prompt}`;
  await writeFile(path, original);
  const ui = uiHarness(root);
  await ui.command('config-composer.membership');
  await ui.select('+agents');
  await ui.select('new');
  await ui.select('group');
  await ui.select('+add');
  await ui.select('reviewers');
  await ui.escape();
  assert.equal(ui.dialog?.title, 'new · developers', 'adding a group must not push a stale membership menu');
  await ui.select('group');
  await ui.select('+add');
  await ui.select('reviewers');
  await ui.select('reviewers');
  await ui.select('earlier');
  assert.ok('options' in ui.dialog);
  assert.deepEqual(
    ui.dialog.options
      .filter((option) => ['developers', 'reviewers'].includes(option.value))
      .map((option) => option.value),
    ['reviewers', 'developers'],
  );
  await ui.select('reviewers');
  await ui.select('remove');
  await ui.select('+add');
  assert.ok(!ui.dialog.options.some((option) => option.value === 'developers'));
  assert.ok(ui.dialog.options.some((option) => option.value === 'reviewers'));
  await ui.select('\u0000back');
  await ui.select('+clear');
  await ui.escape();
  assert.equal(ui.dialog.title, 'new · developers', 'clearing groups must not leave a second membership menu');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(ui.toasts.length, 0);
});

test('compose navigation preserves Back across existing editor sections and their slash aliases', async (t) => {
  const root = await fixture(t);
  const before = await readFile(join(root, 'config-composer.jsonc'), 'utf8');
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  assert.equal(ui.title(), 'Compose');
  await ui.select('groups');
  assert.equal(ui.title(), 'Agent groups');
  await ui.select('developers');
  assert.equal(ui.title(), 'Group: developers');
  await ui.select('\u0000back');
  await ui.select('\u0000back');
  assert.equal(ui.title(), 'Compose');
  await ui.select('models');
  assert.equal(ui.title(), 'Agent models: scope');
  await ui.escape();
  assert.equal(ui.title(), 'Compose');
  await ui.escape();
  assert.equal(Boolean(ui.dialog), false);
  await ui.command('config-composer.membership');
  assert.equal(ui.title(), 'Agent groups');
  await ui.escape();
  assert.equal(ui.dialog, undefined);
  assert.equal(await readFile(join(root, 'config-composer.jsonc'), 'utf8'), before);
});

test('compose inspection shows canonical selection, origins and source editability without writing files', async (t) => {
  const root = await fixture(t);
  const before = await readFile(join(root, 'config-composer.jsonc'), 'utf8');
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('effective');
  assert.equal(ui.title(), 'Saved composition preview');
  await ui.select('+profiles');
  assert.match(ui.message(), /work/);
  assert.match(ui.message(), /project-wide/);
  await ui.escape();
  await ui.select('/agent/builtin/model');
  assert.match(ui.message(), /example\/fast/);
  assert.match(ui.message(), /componentGroups\/developers\/configuration\/model/);
  assert.match(ui.message(), /Saved preview/);
  await ui.escape();
  await ui.select('+sources');
  assert.match(ui.message(), /config-composer.jsonc/);
  assert.match(ui.message(), /Writable/);
  assert.match(ui.message(), /running configuration may differ/);
  assert.equal(await readFile(join(root, 'config-composer.jsonc'), 'utf8'), before);
  assert.equal(ui.updates, 0);
});

test('running inspection reads the server despite invalid saved composition and never writes', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  ui.setProject(root);
  await ui.freezeServer();
  const path = join(root, 'config-composer.jsonc');
  await writeFile(path, '{ invalid saved composition');
  const before = await readFile(path, 'utf8');
  const native = await readFile(join(root, 'opencode.jsonc'), 'utf8');
  await ui.command('config-composer.compose');
  await ui.select('running');
  assert.equal(ui.title(), 'Running configuration inspector');
  await ui.select('model');
  assert.match(ui.message(), /example\/fast/);
  await ui.escape();
  await ui.select('limits');
  assert.match(ui.message(), /TUI/);
  assert.match(ui.message(), /unavailable|cannot/i);
  await ui.escape();
  await ui.select('refresh');
  assert.equal(ui.title(), 'Running configuration inspector');
  await ui.escape();
  assert.equal(ui.title(), 'Compose');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), native);
  assert.equal(ui.updates, 0);
  assert.equal(ui.toasts.length, 0);
});

for (const transition of ['dismiss', 'route', 'client', 'dispose']) {
  test(`running inspection cannot reopen after ${transition} while a server read is pending`, async (t) => {
    const root = await fixture(t);
    const ui = uiHarness(root);
    ui.setProject(root);
    await ui.freezeServer();
    await ui.command('config-composer.compose');
    const gate = ui.delayConfig();
    const pending = ui.select('running');
    await gate.requested;
    if (transition === 'dismiss') {
      await ui.escape();
    } else if (transition === 'route') {
      Object.assign(ui.api.route, { current: { name: 'session', params: { sessionID: 'another' } } });
    } else if (transition === 'client') {
      Object.assign(ui.api, { client: new Proxy(ui.api.client, {}) });
    } else {
      ui.controller.abort();
    }
    gate.resolve();
    await pending;
    assert.notEqual(ui.title(), 'Running configuration inspector');
    assert.equal(ui.updates, 0);
  });
}

for (const section of ['groups', 'models', 'effective']) {
  test(`closing Compose while ${section} loads does not reopen the cancelled view`, async (t) => {
    const ui = uiHarness(await fixture(t));
    await ui.command('config-composer.compose');
    const gate = ui.delayProofAfter(0);
    const pending = ui.select(section);
    await gate.requested;
    await ui.escape();
    gate.resolve();
    await pending;
    assert.equal(ui.dialog, undefined);
    assert.equal(ui.updates, 0);
  });
}

test('compose permission inspection preserves ordered contributions and states the integration boundary', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: {
        developers: {
          agents: ['build'],
          configuration: {
            permissions: [
              { tool: 'bash', action: 'deny' },
              { tool: 'bash', pattern: 'git *', action: 'allow' },
            ],
          },
        },
        reviewers: {},
        'custom-team': {},
      },
      profiles: { work: { layers: [{ componentGroup: 'developers' }] } },
      activeProfiles: ['work'],
    }),
  );
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('effective');
  await ui.select('+permissions');
  assert.ok(ui.message().indexOf('bash * → deny') < ui.message().indexOf('bash git * → allow'));
  assert.match(ui.message(), /native defaults and session approvals are outside this preview/);
  assert.equal(ui.updates, 0);
});

test('compose inspection includes pinned component models even when field origin is unavailable', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'component.md'), '---\nmodel: example/pinned\nvariant: high\n---\nPinned prompt');
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      components: { agents: { 'team/worker': { file: './component.md' } } },
      componentGroups: {
        developers: {},
        reviewers: {},
        'custom-team': {},
        work: { agents: ['team/worker'], configuration: { model: 'example/fast' } },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('effective');
  await ui.select('/agent/team~1worker/model');
  assert.match(ui.message(), /example\/pinned/);
  assert.match(ui.message(), /origin unavailable/);
  await ui.escape();
  await ui.select('/agent/team~1worker/variant');
  assert.match(ui.message(), /high/);
});

for (const section of ['models', 'groups']) {
  test(`Compose reload links preserve Back through the ${section} section`, async (t) => {
    const ui = uiHarness(await fixture(t));
    await ui.command('config-composer.compose');
    await ui.select('reload');
    await ui.select(section);
    await ui.select('\u0000back');
    assert.equal(ui.title(), 'Settings saved');
    await ui.escape();
    assert.equal(ui.title(), 'Compose');
  });
}

test('registry UI creates an inactive profile at an explicit source and retains activation', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('profiles');
  await ui.select('+create');
  await ui.enter('review');
  assert.equal(ui.title(), 'Save new definition in…');
  await ui.select(join(root, 'config-composer.jsonc'));
  assert.equal(ui.title(), 'Save composition definition?');
  await ui.confirm();
  const current = await loadSnapshot(root);
  assert.deepEqual(current.sources.registry.profiles?.review, { layers: [] });
  assert.deepEqual(current.sources.activeProfiles, ['work']);
  assert.equal(ui.updates, 0);
});

test('profile layer edits retain order, preview impact, and can be cancelled without writes', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const before = await readFile(path, 'utf8');
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('profiles');
  await ui.select('work');
  await ui.select('layers');
  await ui.select('1');
  await ui.select('earlier');
  await ui.select('+save');
  assert.equal(ui.title(), 'Save composition definition?');
  await ui.cancel();
  assert.equal(await readFile(path, 'utf8'), before);
  await ui.select('+save');
  await ui.confirm();
  assert.deepEqual(
    (await loadSnapshot(root)).sources.registry.profiles?.work.layers?.map((layer) => layer.componentGroup),
    ['reviewers', 'developers'],
  );
});

test('profile availability editor includes disabled and dormant agents, preserves cancellation and saves without applying', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const document = parseConfig(await readFile(path, 'utf8'));
  document.components = {
    agents: { dormant: { prompt: 'Dormant body' }, '+save': { prompt: 'Reserved-looking name' } },
  };
  await writeFile(path, JSON.stringify(document));
  const before = await readFile(path, 'utf8');
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('profiles');
  await ui.select('work');
  await ui.select('availability');
  assert.ok(ui.dialog !== undefined && 'options' in ui.dialog);
  assert.ok(ui.dialog.options.some((option) => option.value === 'agent:disabled'));
  assert.ok(ui.dialog.options.some((option) => option.value === 'agent:dormant'));
  assert.ok(!ui.dialog.options.some((option) => option.value === 'agent:title'));
  await ui.select('agent:+save');
  assert.equal(ui.title(), 'work: +save');
  await ui.select('inherit');
  await ui.select('agent:build');
  await ui.select('disable');
  await ui.select('+save');
  await ui.cancel();
  assert.equal(await readFile(path, 'utf8'), before);
  await ui.select('+save');
  await ui.confirm();
  const saved = await loadSnapshot(root);
  assert.equal(saved.sources.registry.profiles?.work.agentAvailability?.build, false);
  assert.equal(saved.resolved.agentAvailability.build.status, 'disabled');
  assert.equal(saved.resolved.agentAvailability.dormant.status, 'unselected');
  assert.equal(ui.updates, 0);
  await ui.command('config-composer.compose');
  await ui.select('effective');
  await ui.select('+availability');
  await ui.select('build');
  assert.match(ui.message(), /disabled.*primary/);
  assert.match(ui.message(), /profiles\/work\/agentAvailability\/build/);
});

test('registry UI renames an active group and its native memberships without changing model outcomes', async (t) => {
  const root = await fixture(t);
  const before = await loadSnapshot(root);
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('componentGroups');
  await ui.select('developers');
  await ui.select('rename');
  await ui.enter('coding');
  assert.equal(ui.title(), 'Save composition definition?');
  await ui.confirm();
  const after = await loadSnapshot(root);
  assert.equal(after.sources.registry.componentGroups?.developers, undefined);
  assert.deepEqual(after.nativeAgents.builtin.groups, ['coding']);
  assert.equal(after.resolved.agent.builtin.model, before.resolved.agent.builtin.model);
  assert.equal(after.resolved.agent['nested/pinned'].model, before.resolved.agent['nested/pinned'].model);
});

test('registry confirmation counts agents returning to native fallback when layers are removed', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: {
        developers: {},
        reviewers: {},
        'custom-team': {},
        work: { agents: ['build'], configuration: { model: 'example/fast' } },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('profiles');
  await ui.select('work');
  await ui.select('layers');
  await ui.select('0');
  await ui.select('remove');
  await ui.select('+save');
  assert.match(ui.message(), /1 agent configuration previews change/);
  assert.match(ui.message(), /native fallback/);
});

test('group member picker repairs unavailable members and keeps component names separate from actions', async (t) => {
  const root = await fixture(t);
  const native = parseConfig(await readFile(join(root, 'opencode.jsonc'), 'utf8'));
  Object.assign(native.agent as Record<string, unknown>, { dormant: { disable: true } });
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify(native));
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      components: { agents: { '+save': { prompt: 'Body' } } },
      componentGroups: { developers: {}, reviewers: {}, 'custom-team': {}, work: { agents: ['dormant', 'removed'] } },
      profiles: {},
      activeProfiles: [],
    }),
  );
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('componentGroups');
  await ui.select('work');
  await ui.select('agents');
  await ui.select('member:dormant');
  await ui.select('member:removed');
  await ui.select('member:+save');
  assert.equal(ui.title(), 'work: agents');
  await ui.select('+save');
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root)).sources.registry.componentGroups?.work.agents, ['+save']);
});

test('compose accumulates active membership repairs, rejects incomplete drafts, and saves without applying', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.freezeServer();
  const file = join(root, 'config-composer.jsonc');
  const value = parseConfig(await readFile(file, 'utf8'));
  const definitions = value.componentGroups as Record<string, { agents?: string[] }>;
  definitions.developers.agents = ['removed', 'build'];
  definitions.reviewers.agents = ['also-removed', 'plan'];
  const before = JSON.stringify(value);
  await writeFile(file, before);
  const nativeBefore = await readFile(join(root, 'opencode.jsonc'), 'utf8');
  await ui.command('config-composer.compose');
  await ui.select('repair');
  assert.equal(ui.title(), 'Repair invalid memberships');
  await ui.select('group:developers');
  await ui.select('agents');
  await ui.select('member:removed');
  await ui.select('+keep');
  await ui.select('\u0000back');
  await ui.select('+review');
  assert.match(ui.toasts.at(-1)!.message, /also-removed/);
  assert.equal(await readFile(file, 'utf8'), before);
  await ui.select('group:reviewers');
  await ui.select('agents');
  await ui.select('member:also-removed');
  await ui.select('+keep');
  await ui.select('\u0000back');
  await ui.select('+review');
  assert.equal(ui.title(), 'Save membership repair?');
  assert.match(ui.message(), /previous saved configuration is invalid/i);
  assert.match(ui.message(), /config-composer.jsonc/);
  await ui.cancel();
  assert.equal(await readFile(file, 'utf8'), before);
  await ui.select('+review');
  await ui.confirm();
  assert.equal(ui.updates, 0);
  assert.deepEqual((await loadSnapshot(root)).sources.registry.componentGroups?.developers.agents, ['build']);
  assert.deepEqual((await loadSnapshot(root)).sources.registry.componentGroups?.reviewers.agents, ['plan']);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), nativeBefore);
});

test('membership repair confirmation exposes permission fallback before saving an otherwise valid candidate', async (t) => {
  const root = await fixture(t);
  const nativePath = join(root, 'opencode.jsonc');
  const native = parseConfig(await readFile(nativePath, 'utf8'));
  (native.agent as Record<string, AgentSettings>).builtin.permission = { skill: 'allow' };
  const nativeBefore = JSON.stringify(native);
  await writeFile(nativePath, nativeBefore);
  const ui = uiHarness(root);
  await ui.freezeServer();
  const file = join(root, 'config-composer.jsonc');
  const value = parseConfig(await readFile(file, 'utf8'));
  const definitions = value.componentGroups as Record<string, Record<string, unknown>>;
  definitions.developers.agents = ['removed'];
  definitions.developers.configuration = {
    permissions: [
      { tool: 'webfetc?', pattern: 'a', action: 'deny' },
      { tool: 'webfetch', action: 'allow' },
      { tool: 'webfetc?', pattern: 'b', action: 'deny' },
      { tool: 'skill', action: 'deny' },
    ],
  };
  const before = JSON.stringify(value);
  await writeFile(file, before);
  await ui.command('config-composer.compose');
  await ui.select('repair');
  await ui.select('group:developers');
  await ui.select('agents');
  await ui.select('member:removed');
  await ui.select('member:builtin');
  await ui.select('+keep');
  await ui.select('\u0000back');
  await ui.select('+review');
  assert.equal(ui.title(), 'Save membership repair?');
  assert.match(ui.message(), /All Composer.*agent.*not applied/);
  assert.match(ui.message(), /builtin/);
  assert.match(ui.message(), /more permissive/i);
  assert.ok(ui.message().indexOf('Fallback may be more') < ui.message().indexOf(file));
  assert.equal(await readFile(file, 'utf8'), before, 'warning is visible before any write');
  await ui.cancel();
  assert.equal(await readFile(file, 'utf8'), before);
  await ui.select('+review');
  await ui.confirm();
  const saved = await loadSnapshot(root);
  assert.ok(saved.resolved.permissionWarnings.some((warning) => warning.scope === 'agent:builtin'));
  assert.deepEqual(saved.resolved.agent.builtin.permission, { skill: 'allow' });
  assert.equal(ui.updates, 0, 'saving the warned candidate still does not apply it');
  assert.equal(await readFile(nativePath, 'utf8'), nativeBefore);
});

test('new configuration presets choose model settings before saving a valid definition', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('configurationPresets');
  await ui.select('+create');
  await ui.enter('quick');
  await ui.select(join(root, 'config-composer.jsonc'));
  await ui.select('example/fast');
  await ui.select('');
  assert.equal(ui.title(), 'Save composition definition?');
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root)).sources.registry.configurationPresets?.quick, { model: 'example/fast' });
});

test('inactive preset creation rechecks provider availability before saving', async (t) => {
  const root = await fixture(t);
  const before = await readFile(join(root, 'config-composer.jsonc'), 'utf8');
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('configurationPresets');
  await ui.select('+create');
  await ui.enter('quick');
  await ui.select(join(root, 'config-composer.jsonc'));
  await ui.select('example/fast');
  await ui.select('');
  ui.setProviderError(true);
  await ui.confirm();
  assert.match(ui.toasts.at(-1)!.message, /Could not load provider models/);
  assert.equal(await readFile(join(root, 'config-composer.jsonc'), 'utf8'), before);
  assert.equal(ui.updates, 0);
});

for (const field of ['model', 'small_model'] as const) {
  test(`profile parent edits revalidate changed ${field} even without agent model changes`, async (t) => {
    const root = await fixture(t);
    const path = join(root, 'config-composer.jsonc');
    const value = parseConfig(await readFile(path, 'utf8'));
    (value.profiles as Record<string, unknown>).unavailable = { overrides: { [field]: 'missing/unavailable' } };
    await writeFile(path, JSON.stringify(value));
    const before = await readFile(path, 'utf8');
    const ui = uiHarness(root);
    await ui.command('config-composer.compose');
    await ui.select('registry');
    await ui.select('profiles');
    await ui.select('work');
    await ui.select('parent');
    await ui.select('unavailable');
    assert.match(ui.message(), /missing\/unavailable/);
    await ui.confirm();
    assert.match(ui.toasts.at(-1)!.message, /not available|unavailable|provider/i);
    assert.equal(await readFile(path, 'utf8'), before);
  });
}

test('newly selected commands revalidate their authored model before saving membership', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const value = parseConfig(await readFile(path, 'utf8'));
  value.components = { commands: { check: { file: './check.md' } } };
  await writeFile(join(root, 'check.md'), '---\nmodel: missing/unavailable\n---\nCheck this.');
  await writeFile(path, JSON.stringify(value));
  const before = await readFile(path, 'utf8');
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('componentGroups');
  await ui.select('developers');
  await ui.select('commands');
  await ui.select('member:check');
  await ui.select('+save');
  assert.match(ui.message(), /missing\/unavailable/);
  await ui.confirm();
  assert.match(ui.toasts.at(-1)!.message, /not available|unavailable|provider/i);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('removing a profile parent previews native fallback from the server baseline, not the composed response', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const value = parseConfig(await readFile(path, 'utf8'));
  const profiles = value.profiles as Record<string, Record<string, unknown>>;
  profiles.parent = { overrides: { model: 'example/deep' } };
  profiles.work.extends = 'parent';
  await writeFile(path, JSON.stringify(value));
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('profiles');
  await ui.select('work');
  await ui.select('parent');
  await ui.select('');
  assert.match(ui.message(), /Changed global models: model: example\/fast/);
  await ui.confirm();
  assert.equal((await loadSnapshot(root)).sources.registry.profiles?.work.extends, undefined);
  assert.ok(!(await readFile(join(root, 'opencode.jsonc'), 'utf8')).includes('__configComposerRuntime'));
});

test('instance apply retains saved native JSON edits and requests restart for the global cache', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.freezeServer();
  const path = join(root, 'opencode.jsonc');
  const before = await readFile(path, 'utf8');
  await writeFile(path, applyEdits(before, modify(before, ['agent', 'builtin', 'model'], 'example/next', {})));
  await ui.command();
  assert.match(ui.toasts.at(-1)!.message, /Native agent inputs differ/);
  await ui.command('config-composer.compose');
  await ui.select('reload');
  assert.equal(ui.updates, 0);
  assert.equal(ui.globalUpdates, 0);
  assert.match(ui.toasts.at(-1)!.message, /Native agent inputs differ/);
  assert.equal(
    (parseConfig(await readFile(path, 'utf8')).agent as Record<string, { model: string }>).builtin.model,
    'example/next',
  );
});

test('profile activation UI distinguishes local none from inheritance and preserves cancellation', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('activation');
  await ui.select('local');
  await ui.select('none');
  assert.match(ui.message(), /local profile selection: none/);
  await ui.cancel();
  await assert.rejects(readFile(join(root, '.opencode/config-composer.local.jsonc')), /ENOENT/);
  await ui.select('none');
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root)).sources.activeProfiles, []);
  await ui.command('config-composer.compose');
  await ui.select('activation');
  await ui.select('local');
  await ui.select('inherit');
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root)).sources.activeProfiles, ['work']);
});

test('ordered activation editor reorders unique pending profiles before saving', async (t) => {
  const root = await fixture(t);
  const value = parseConfig(await readFile(join(root, 'config-composer.jsonc'), 'utf8'));
  (value.profiles as Record<string, unknown>).review = { layers: [] };
  await writeFile(join(root, 'config-composer.jsonc'), JSON.stringify(value));
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('activation');
  await ui.select('local');
  await ui.select('ordered');
  await ui.select('+add');
  assert.ok(
    ui.dialog !== undefined && 'options' in ui.dialog && !ui.dialog.options.some((option) => option.value === 'work'),
  );
  await ui.select('review');
  await ui.select('1');
  await ui.select('earlier');
  await ui.select('+save');
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root)).sources.activeProfiles, ['review', 'work']);
});

test('project writes require project filesystem proof after the installation proof succeeds', async (t) => {
  const root = await fixture(t);
  const project = await mkdtemp(join(tmpdir(), 'composer-ui-project-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const ui = uiHarness(root);
  ui.setProject(project);
  await ui.command('config-composer.compose');
  await ui.select('activation');
  await ui.select('project');
  await ui.select('create');
  ui.setProjectProofError(true);
  await ui.confirm();
  assert.match(ui.toasts.at(-1)!.message, /shared filesystem/);
  await assert.rejects(readFile(join(project, '.opencode/config-composer.jsonc')), /ENOENT/);
});

test('first-source creation makes a project definition destination available without changing conversations', async (t) => {
  const root = await fixture(t);
  const project = await mkdtemp(join(tmpdir(), 'composer-ui-first-source-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await rm(join(root, 'config-composer.jsonc'));
  const ui = uiHarness(root);
  ui.setProject(project);
  await ui.command('config-composer.compose');
  await ui.select('activation');
  await ui.select('project');
  await ui.select('create');
  await ui.confirm();
  const source = join(project, '.opencode/config-composer.jsonc');
  assert.deepEqual(parseConfig(await readFile(source, 'utf8')), {});
  await ui.command('config-composer.compose');
  await ui.select('registry');
  await ui.select('profiles');
  await ui.select('+create');
  await ui.enter('review');
  await ui.select(source);
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root, project)).sources.registry.profiles?.review, { layers: [] });
  assert.deepEqual((await loadSnapshot(root, project)).sources.activeProfiles, []);
  assert.equal(ui.updates, 0);
});

test('changing projects before confirmation rejects the previous project scope write', async (t) => {
  const root = await fixture(t);
  const project = await mkdtemp(join(tmpdir(), 'composer-ui-switched-project-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const ui = uiHarness(root);
  ui.setProject(project);
  await ui.command('config-composer.compose');
  await ui.select('activation');
  await ui.select('local');
  await ui.select('none');
  ui.setProject(root);
  await ui.confirm();
  assert.match(ui.toasts.at(-1)!.message, /project changed/);
  await assert.rejects(readFile(join(project, '.opencode/config-composer.local.jsonc')), /ENOENT/);
});

for (const [field, text, expected] of [
  ['temperature', '0.4', 0.4],
  ['topP', '0.8', 0.8],
  ['topK', '16', 16],
  ['maxOutputTokens', '128', 128],
  ['options', '{"custom":[true,null,"value"]}', { custom: [true, null, 'value'] }],
] as const) {
  test(`parameter UI edits ${field} at its explicit destination and retains cancel/back behavior`, async (t) => {
    const root = await fixture(t);
    const path = join(root, 'config-composer.jsonc');
    const original = await readFile(path, 'utf8');
    const ui = uiHarness(root);
    await ui.command('config-composer.compose');
    await ui.select('parameters');
    await ui.select(path);
    await ui.select(JSON.stringify(['componentGroups', 'developers', 'configuration']));
    await ui.select(field);
    await ui.enter(text);
    assert.match(ui.message(), /parameters|provider-unverified/);
    await ui.cancel();
    assert.equal(await readFile(path, 'utf8'), original);
    await ui.escape();
    await ui.select(field);
    await ui.enter(text);
    await ui.confirm();
    const parameters = (await loadSnapshot(root)).sources.registry.componentGroups?.developers.configuration
      ?.parameters;
    assert.deepEqual(parameters?.[field], expected);
  });
}

test('parameter UI rejects a lost provider catalog at confirmation without writing', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const original = await readFile(path, 'utf8');
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('parameters');
  await ui.select(path);
  await ui.select(JSON.stringify(['componentGroups', 'developers', 'configuration']));
  await ui.select('temperature');
  await ui.enter('0.4');
  ui.setProviderError(true);
  await ui.confirm();
  assert.match(ui.toasts.at(-1)!.message, /provider models/);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('permission UI edits, reorders and previews rules without saving cancelled drafts', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const original = await readFile(path, 'utf8');
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('permissions');
  await ui.select(path);
  await ui.select(JSON.stringify(['componentGroups', 'developers', 'configuration']));
  await ui.select('+add');
  await ui.select('0');
  await ui.select('tool');
  await ui.enter('bash');
  await ui.select('pattern');
  await ui.enter('git *');
  await ui.select('action');
  await ui.select('deny');
  await ui.escape();
  await ui.select('+add');
  await ui.select('1');
  await ui.select('action');
  await ui.select('allow');
  await ui.select('earlier');
  await ui.select('+preview');
  await ui.select('+local');
  await ui.enter('bash');
  await ui.enter('git status');
  assert.match(ui.message(), /deny: bash git \*/);
  assert.match(ui.message(), /Earlier matching contributions/);
  assert.match(ui.message(), /unsupported scope/);
  await ui.escape();
  await ui.escape();
  await ui.escape();
  await ui.escape();
  await ui.select('1');
  await ui.select('earlier');
  await ui.select('+save');
  assert.ok(ui.message().indexOf('bash git * → deny') < ui.message().indexOf('* * → allow'));
  assert.match(ui.message(), /Reload saved settings to apply/);
  await ui.cancel();
  assert.equal(await readFile(path, 'utf8'), original);
  await ui.select('+save');
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root)).sources.registry.componentGroups?.developers.configuration?.permissions, [
    { tool: 'bash', pattern: 'git *', action: 'deny' },
    { tool: '*', action: 'allow' },
  ]);
  assert.equal(ui.title(), 'Settings saved');
  assert.equal(ui.updates, 0);
});

test('permission UI creates an inactive permission-only preset without choosing a model', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('permissions');
  await ui.select(path);
  await ui.select('+create');
  await ui.enter('checks');
  await ui.confirm();
  const snapshot = await loadSnapshot(root);
  assert.deepEqual(snapshot.sources.registry.configurationPresets?.checks, { permissions: [] });
  assert.deepEqual(snapshot.sources.activeProfiles, ['work']);
  assert.equal(ui.updates, 0);
});

test('permission save puts candidate fallback before long source paths and ordered rule details', async (t) => {
  const root = await fixture(t);
  const file = join(root, 'config-composer.jsonc');
  const value = parseConfig(await readFile(file, 'utf8'));
  const definitions = value.componentGroups as Record<string, Record<string, unknown>>;
  definitions.developers.configuration = {
    permissions: [
      { tool: 'webfetc?', pattern: 'a', action: 'deny' },
      { tool: 'webfetch', action: 'allow' },
      { tool: 'webfetc?', pattern: 'b', action: 'deny' },
    ],
  };
  await writeFile(file, JSON.stringify(value));
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('permissions');
  await ui.select(file);
  await ui.select(JSON.stringify(['componentGroups', 'developers', 'configuration']));
  await ui.select('+save');
  assert.match(ui.message(), /^Fallback may be more permissive/);
  assert.match(ui.message(), /Agent builtin:/);
  assert.ok(ui.message().indexOf('Fallback may be more') < ui.message().indexOf(file));
  assert.ok(ui.message().indexOf('Fallback may be more') < ui.message().indexOf('webfetc?'));
  assert.equal(ui.updates, 0);
});

test('permission agent previews cannot collide with local-definition navigation values', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [packageName], agent: { '+local': { groups: ['developers', 'reviewers'] } } }),
  );
  await writeFile(
    path,
    JSON.stringify({
      componentGroups: {
        developers: { configuration: { permissions: [{ tool: 'bash', action: 'deny' }] } },
        reviewers: { configuration: { permissions: [{ tool: 'bash', action: 'allow' }] } },
        'custom-team': {},
      },
      profiles: { work: { layers: [{ componentGroup: 'developers' }, { componentGroup: 'reviewers' }] } },
      activeProfiles: ['work'],
    }),
  );
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('permissions');
  await ui.select(path);
  await ui.select(JSON.stringify(['componentGroups', 'developers', 'configuration']));
  await ui.select('+preview');
  await ui.select('agent:+local');
  await ui.enter('bash');
  await ui.enter('git status');
  assert.match(ui.message(), /allow: bash/);
  assert.match(ui.message(), /componentGroups\/reviewers/);
});

test('prompt UI preserves multiline fragment order and cancellation before saving', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const original = await readFile(path, 'utf8');
  const ui = uiHarness(root);
  await ui.command('config-composer.compose');
  await ui.select('prompts');
  await ui.select(path);
  await ui.select(JSON.stringify(['componentGroups', 'developers', 'configuration']));
  await ui.select('append');
  await ui.select('+add');
  await ui.enter('First\nSecond');
  await ui.select('+add');
  await ui.enter('Last');
  await ui.select('1');
  await ui.select('earlier');
  await ui.select('1');
  await ui.select('edit');
  await ui.enter('First\nRevised second');
  await ui.select('+save');
  assert.match(ui.message(), /Last.*First\\nRevised second/s);
  await ui.cancel();
  assert.equal(await readFile(path, 'utf8'), original);
  await ui.select('+save');
  await ui.confirm();
  assert.deepEqual(
    (await loadSnapshot(root)).sources.registry.componentGroups?.developers.configuration?.prompt?.append,
    ['Last', 'First\nRevised second'],
  );
  assert.equal(ui.updates, 0);
});

test('prompt UI validates includes before writing and resets local inheritance controls', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const original = await readFile(path, 'utf8');
  const ui = uiHarness(root);
  const target = JSON.stringify(['overrides', 'agents', 'nested/pinned']);
  const open = async () => {
    await ui.command('config-composer.compose');
    await ui.select('prompts');
    await ui.select(path);
    await ui.select(target);
  };
  await open();
  await ui.select('append');
  await ui.select('+add');
  await ui.enter('{{include:@missing/file.md}}');
  await ui.select('+save');
  assert.match(ui.toasts.at(-1)!.message, /source.*does not exist/);
  assert.equal(await readFile(path, 'utf8'), original);
  await open();
  await ui.select('inheritGroups');
  await ui.select('false');
  await ui.confirm();
  assert.equal(
    (await loadSnapshot(root)).sources.scopes[0].value.overrides?.agents?.['nested/pinned'].prompt?.inheritGroups,
    false,
  );
  await open();
  await ui.select('reset');
  await ui.confirm();
  assert.equal(
    (await loadSnapshot(root)).sources.scopes[0].value.overrides?.agents?.['nested/pinned']?.prompt,
    undefined,
  );
});

test('prompt source UI creates aliases and reusable multiline bodies with cancellation and ordered references', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  await mkdir(join(root, 'snippets'));
  const document = parseConfig(await readFile(path, 'utf8'));
  document.components = { agents: { authored: { prompt: 'Authored base' } } };
  const groups = document.componentGroups as Record<string, { agents?: string[] }>;
  groups.developers.agents = ['authored'];
  await writeFile(path, JSON.stringify(document));
  const ui = uiHarness(root);
  const open = async (registry: string) => {
    await ui.command('config-composer.compose');
    await ui.select('prompt-sources');
    await ui.select(registry);
  };
  await open('sourceDirectories');
  await ui.select('+create');
  await ui.enter('snippets');
  await ui.select(path);
  await ui.enter('./snippets');
  await ui.confirm();
  assert.equal((await loadSnapshot(root)).sources.registry.sourceDirectories?.snippets, join(root, 'snippets'));
  await open('prompts');
  await ui.select('+create');
  await ui.enter('notes');
  await ui.select(path);
  await ui.select('text');
  await ui.enter('First\nSecond');
  await ui.cancel();
  assert.equal((await loadSnapshot(root)).sources.registry.components?.prompts?.notes, undefined);
  await ui.enter('First\nSecond');
  await ui.confirm();
  await open('references');
  await ui.select('agent:authored');
  await ui.select('+add');
  await ui.select('prompt:notes');
  await ui.select('+add');
  await ui.select('prompt:notes');
  await ui.select('1');
  await ui.select('earlier');
  await ui.select('+save');
  assert.match(ui.message(), /Authored base/);
  await ui.confirm();
  assert.equal(
    (await loadSnapshot(root)).resolved.agent.authored.prompt,
    'Authored base\n\nFirst\nSecond\n\nFirst\nSecond',
  );
  await open('prompts');
  await ui.select('asset:notes');
  await ui.select('rename');
  await ui.enter('review/notes');
  assert.match(ui.message(), /authored\/promptRefs/);
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root)).sources.registry.components?.agents?.authored.promptRefs, [
    'review/notes',
    'review/notes',
  ]);
  await open('references');
  await ui.select('agent:authored');
  await ui.select('+reset');
  await ui.confirm();
  await open('prompts');
  await ui.select('asset:review/notes');
  await ui.select('delete');
  await ui.confirm();
  assert.equal((await loadSnapshot(root)).sources.registry.components?.prompts?.['review/notes'], undefined);
  assert.equal(ui.updates, 0);
});

async function shortcutFixture(t: TestContext) {
  const root = await fixture(t);
  const path = join(root, 'config-composer.jsonc');
  const source = parseConfig(await readFile(path, 'utf8'));
  source.profileShortcuts = { quiet: { activeProfiles: [], description: 'Select no profiles' } };
  await writeFile(path, JSON.stringify(source));
  const ui = uiHarness(root);
  await ui.freezeServer();
  await ui.refreshShortcuts();
  return { root, path, source, ui };
}

test('profile shortcuts choose an explicit destination and reuse cancellation, preview, save and pending apply', async (t) => {
  const { root, ui } = await shortcutFixture(t);
  assert.ok(ui.commandNames().includes('config-composer.shortcut.quiet'));
  await ui.command('config-composer.shortcut.quiet');
  assert.equal(ui.title(), '/quiet: save profile selection in…');
  assert.match(JSON.stringify(ui.dialog), /profiles: none/);
  await ui.select('local');
  assert.match(ui.message(), /Shortcut \/quiet: none/);
  assert.match(ui.message(), /Destination: local/);
  await ui.cancel();
  await assert.rejects(readFile(join(root, '.opencode/config-composer.local.jsonc')), /ENOENT/);
  await ui.select('local');
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root)).sources.activeProfiles, []);
  assert.match(JSON.stringify(ui.dialog), /Saved Composer revision .* pending/);
  assert.equal(ui.updates, 0, 'shortcut save never silently applies');
  await ui.select('reload');
  await ui.confirm();
  assert.equal(ui.updates, 1);
});

test('shortcut registration rejects native commands and later TUI aliases without overriding existing actions', async (t) => {
  const { ui } = await shortcutFixture(t);
  ui.setNativeCommands(['quiet']);
  await ui.refreshShortcuts();
  assert.ok(!ui.commandNames().includes('config-composer.shortcut.quiet'));
  assert.match(ui.toasts.at(-1)!.message, /conflicts.*command or alias/);
  assert.ok(ui.commandNames().includes('config-composer.compose'));
  ui.setNativeCommands([]);
  await ui.refreshShortcuts();
  ui.api.keymap.registerLayer({
    commands: [{ name: 'other.action', slashName: 'other', slashAliases: ['quiet'], run: () => {} }],
  });
  assert.ok(!ui.commandNames().includes('config-composer.shortcut.quiet'));
  assert.ok(ui.commandNames().includes('other.action'));
  assert.equal(ui.updates, 0);
});

test('shortcut activation rejects disabled targets before saving its selected destination', async (t) => {
  const { root, path, source, ui } = await shortcutFixture(t);
  source.componentGroups = { unavailable: { agents: ['disabled'] } };
  source.profiles = { blocked: { layers: [{ componentGroup: 'unavailable' }] } };
  source.activeProfiles = [];
  source.profileShortcuts = { quiet: { activeProfiles: ['blocked'] } };
  await writeFile(path, JSON.stringify(source));
  await ui.refreshShortcuts();
  await ui.command('config-composer.shortcut.quiet');
  await ui.select('local');
  assert.match(ui.toasts.at(-1)!.message, /disabled/);
  await assert.rejects(readFile(join(root, '.opencode/config-composer.local.jsonc')), /ENOENT/);
  assert.equal(ui.updates, 0);
});

test('native prompt command collisions reject the server hook before publishing Composer changes', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({ profileShortcuts: { quiet: { activeProfiles: [] } }, defaults: { model: 'example/new' } }),
  );
  const hooks = await server.server({} as PluginInput, { configFile: join(root, 'config-composer.jsonc') });
  const native = { model: 'example/original', command: { quiet: { template: 'Preserve this prompt' } } };
  const before = structuredClone(native);
  await assert.rejects(hooks.config!(native), /Shortcut \/quiet conflicts/);
  assert.deepEqual({ model: native.model, command: native.command }, before);
});

test('changed shortcut definitions reject stale command callbacks and instance changes reject confirmation', async (t) => {
  const { root, path, source, ui } = await shortcutFixture(t);
  source.profileShortcuts = { quiet: { activeProfiles: ['work'] } };
  await writeFile(path, JSON.stringify(source));
  await ui.command('config-composer.shortcut.quiet');
  assert.match(ui.toasts.at(-1)!.message, /Shortcut \/quiet changed/);
  await ui.refreshShortcuts();
  await ui.command('config-composer.shortcut.quiet');
  await ui.select('shared');
  const before = await readFile(path, 'utf8');
  const other = join(root, 'other');
  await mkdir(other);
  ui.setProject(other);
  await ui.confirm();
  assert.equal(await readFile(path, 'utf8'), before);
  assert.match(ui.toasts.at(-1)!.message, /instance|connection|workspace/);
  assert.equal(ui.updates, 0);
});

for (const change of ['route', 'dialog', 'abort'] as const) {
  test(`a delayed shortcut cannot reopen its destination after ${change}`, async (t) => {
    const { ui } = await shortcutFixture(t);
    const proof = ui.delayProofAfter(0);
    const pending = ui.command('config-composer.shortcut.quiet');
    await proof.requested;
    if (change === 'route') {
      Object.assign(ui.api.route, { current: { name: 'session', params: { sessionID: 'other' } } });
    } else if (change === 'dialog') {
      ui.api.ui.dialog.replace(() => ui.api.ui.DialogSelect({ title: 'Other dialog', options: [] }));
    } else {
      ui.controller.abort();
    }
    const previous = ui.dialog;
    proof.resolve();
    await pending;
    assert.equal(ui.dialog, previous);
    assert.equal(ui.updates, 0);
  });
}
