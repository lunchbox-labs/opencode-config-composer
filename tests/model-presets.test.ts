import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import type {
  TuiDialogConfirmProps,
  TuiDialogPromptProps,
  TuiDialogSelectProps,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui';
import {
  type AgentSettings,
  type NativeModels,
  applyDefaults,
  catalogModels,
  groupChoice,
  readSettings,
  resolveChoice,
  resolveGroup,
  validateChoice,
} from '../src/config-composer/settings.ts';
import server from '../src/server.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { registerSettings } from '../src/config-composer/tui.ts';
import {
  affectedGroups,
  loadSnapshot,
  parseConfig,
  planChange,
  plannedChoices,
  savePlan,
} from '../src/config-composer/storage.ts';

const options = {
  modelPresets: { balanced: { model: 'fixture/fast', variant: 'high' }, unused: { model: 'fixture/fast' } },
  groups: {
    developers: { modelRef: 'preset:balanced' },
    reviewers: { modelRef: 'preset:balanced', variant: 'low' },
    workflow: { modelRef: 'opencode:model', variant: 'high' },
    system: { modelRef: 'opencode:small_model' },
    fallback: {},
  },
};
const providers = [
  {
    id: 'fixture',
    models: {
      fast: { name: 'Fast', variants: { low: {}, high: {}, hidden: { disabled: true } } },
      next: { name: 'Next', variants: { low: {}, high: {} } },
      small: { name: 'Small', variants: {} },
    },
  },
];
const catalog = catalogModels(providers);
const context = { modelPresets: options.modelPresets, native: { model: 'fixture/next', small_model: 'fixture/small' } };

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'model-presets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agents'));
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      configurationPresets: options.modelPresets,
      componentGroups: Object.fromEntries(
        Object.entries(options.groups).map(([name, configuration]) => [name, { configuration }]),
      ),
      profiles: { work: { layers: Object.keys(options.groups).map((componentGroup) => ({ componentGroup })) } },
      activeProfiles: ['work'],
    }),
  );
  await writeFile(
    join(root, 'opencode.jsonc'),
    '// Preserve this comment.\n' +
      JSON.stringify(
        {
          plugin: [packageName],
          model: 'fixture/fast',
          small_model: 'fixture/small',
          permission: { edit: 'ask' },
          agent: {
            worker: { groups: ['developers'] },
            reviewer: { groups: ['reviewers'] },
            lead: { groups: ['workflow'] },
            pinned: { groups: ['developers'], model: 'fixture/small' },
          },
        },
        null,
        2,
      ) +
      '\n',
  );
  await writeFile(join(root, 'agents/extra.md'), '---\ngroups: [developers]\nvariant: low\n---\nKeep this prompt.\n');
  return root;
}

test('references are explicit, flat, validated, and separate from native fallback', () => {
  assert.deepEqual(readSettings({ agent: options }), {
    ...options,
    promptSources: {},
    promptDefaults: {},
    agentPrompts: {},
  });
  assert.deepEqual(readSettings({}), {
    groups: {},
    modelPresets: {},
    promptSources: {},
    promptDefaults: {},
    agentPrompts: {},
  });
  assert.deepEqual(resolveGroup({}, context), {});
  assert.deepEqual(resolveGroup({ modelRef: 'opencode:model' }, context), {
    modelRef: 'opencode:model',
    model: 'fixture/next',
    variant: undefined,
  });
  assert.equal(resolveGroup(options.groups.system, context).model, 'fixture/small');
  assert.equal(resolveGroup(options.groups.developers, context).variant, 'high');
  assert.equal(resolveGroup(options.groups.reviewers, context).variant, 'low');
  for (const bad of [
    { modelRef: 'opencode:other' },
    { modelRef: 'group:developers' },
    { modelRef: 'preset:' },
    { modelRef: 'preset:UPPER' },
    { modelRef: 'preset:constructor' },
    { modelRef: 'preset:../bad' },
    { model: 'fixture/fast', modelRef: 'opencode:model' },
    { modelRef: 'opencode:model', variant: 'bad value' },
    { variant: 'high' },
    { modelRef: null },
    { model: 7 },
    { modelRef: 'opencode:model', extra: true },
  ]) {
    assert.throws(() => groupChoice(bad));
  }
  for (const bad of [
    { groups: { team: { modelRef: 'preset:missing' } } },
    { modelPresets: { balanced: {} } },
    { modelPresets: { balanced: { variant: 'high' } } },
    { modelPresets: { balanced: { modelRef: 'opencode:model' } } },
    { modelPresets: { balanced: { modelRef: 'preset:balanced' } } },
    { modelPresets: { prototype: { model: 'fixture/fast' } } },
    { modelPresets: [] },
  ]) {
    assert.throws(() => readSettings({ agent: bad }));
  }
  assert.throws(() => resolveGroup({ modelRef: 'opencode:model' }), /no configured model/);
  assert.throws(
    () => resolveGroup({ modelRef: 'opencode:small_model' }, { native: { model: 'fixture/fast' } }),
    /no configured model/,
  );
  assert.throws(() => resolveGroup({ modelRef: 'preset:missing' }, context), /does not exist/);
});

test('agent pins and variant overrides retain precedence without mutating stored references', () => {
  const agents: Record<string, AgentSettings> = {
    inherited: { groups: ['developers'] },
    groupVariant: { groups: ['reviewers'] },
    agentVariant: { options: { groups: ['developers'] }, variant: 'low' },
    pinned: { groups: ['developers'], model: 'fixture/small' },
    workflow: { groups: ['workflow'] },
    fallback: { groups: ['fallback'] },
    unknown: { groups: [] },
    disabled: { disable: true, groups: ['INVALID'] },
  };
  const before = JSON.stringify(options);
  applyDefaults(agents, options.groups, context);
  assert.equal(agents.inherited.model, 'fixture/fast');
  assert.equal(agents.inherited.variant, 'high');
  assert.equal(agents.groupVariant.variant, 'low');
  assert.equal(agents.agentVariant.variant, 'low');
  assert.equal(agents.workflow.model, 'fixture/next');
  assert.equal(agents.pinned.model, 'fixture/small');
  assert.equal(agents.pinned.variant, undefined);
  for (const name of ['fallback', 'unknown', 'disabled']) {
    assert.equal(agents[name].model, undefined);
  }
  assert.equal(JSON.stringify(options), before);
  const atomic: Record<string, AgentSettings> = {
    good: { groups: ['developers'] },
    bad: { groups: ['workflow'] },
  };
  assert.throws(
    () => applyDefaults(atomic, options.groups, { modelPresets: options.modelPresets }),
    /no configured model/,
  );
  assert.equal(atomic.good.model, undefined);
  assert.equal(resolveChoice({ groups: ['workflow'], model: 'fixture/small' }, options.groups).source, 'agent');
});

test('server references use the effective config and reject unsupported referenced variants at dispatch', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: { workflow: { configuration: options.groups.workflow } },
      profiles: { work: { layers: [{ componentGroup: 'workflow' }] } },
      activeProfiles: ['work'],
    }),
  );
  const hooks = await server.server({} as PluginInput, { configFile: join(root, 'config-composer.jsonc') });
  const config = {
    model: 'fixture/next',
    small_model: 'fixture/small',
    agent: {
      worker: { groups: ['workflow'] },
      pinned: { groups: ['workflow'], model: 'fixture/fast' },
    },
  };
  await hooks.config!(config);
  assert.equal((config.agent.worker as AgentSettings).model, 'fixture/next');
  assert.equal(config.agent.pinned.model, 'fixture/fast');
  type Params = Parameters<NonNullable<Hooks['chat.params']>>;
  const input = {
    agent: 'worker',
    model: { providerID: 'fixture', id: 'next', variants: { high: {} } },
  } as unknown as Params[0];
  const output = { options: { groups: ['workflow'], unrelated: true } } as unknown as Params[1];
  await hooks['chat.params']!(input, output);
  assert.deepEqual(output.options, { unrelated: true });
  const invalid = { ...input, model: { providerID: 'fixture', id: 'next', variants: {} } } as unknown as Params[0];
  await assert.rejects(hooks['chat.params']!(invalid, output), /does not support/);
  const override = { ...invalid, model: { providerID: 'fixture', id: 'small', variants: {} } } as unknown as Params[0];
  await hooks['chat.params']!(override, output);
  const requestVariant = {
    ...invalid,
    message: { variant: 'low' },
    model: {
      providerID: 'fixture',
      id: 'next',
      variants: { low: {} },
    },
  } as unknown as Params[0];
  await hooks['chat.params']!(requestVariant, output);
  const disabled = {
    ...requestVariant,
    model: { providerID: 'fixture', id: 'next', variants: { low: { disabled: true } } },
  };
  await assert.rejects(hooks['chat.params']!(disabled as unknown as Params[0], output), /does not support/);
});

test('preset and native edits retain references, comments, prompts, permissions, and pins', async (t) => {
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  const prompt = await readFile(join(root, 'agents/extra.md'), 'utf8');
  const change = { kind: 'preset', name: 'balanced', choice: { model: 'fixture/next', variant: 'high' } } as const;
  const plan = planChange(snapshot, change);
  assert.deepEqual(affectedGroups(snapshot, change).sort(), ['developers', 'reviewers']);
  for (const choice of await plannedChoices(plan)) {
    validateChoice(choice, catalog);
  }
  assert.equal(await readFile(snapshot.configFile.path, 'utf8'), snapshot.configFile.text);
  await savePlan(plan);
  let current = await loadSnapshot(root);
  assert.deepEqual(current.groups, options.groups);
  assert.equal(current.modelPresets.balanced.model, 'fixture/next');
  assert.equal(
    resolveChoice(current.agents.find((agent) => agent.name === 'extra')!.settings, current.groups, {
      modelPresets: current.modelPresets,
      native: current.config,
    }).variant,
    'low',
  );
  assert.equal(current.agents.find((agent) => agent.name === 'pinned')!.settings.model, 'fixture/small');
  assert.deepEqual(current.config.permission, { edit: 'ask' });
  assert.match(current.configFile.text, /Preserve this comment/);
  assert.equal(await readFile(join(root, 'agents/extra.md'), 'utf8'), prompt);
  await savePlan(planChange(current, { kind: 'global', field: 'model', model: 'fixture/next' }));
  current = await loadSnapshot(root);
  assert.deepEqual(current.groups.workflow, options.groups.workflow);
  assert.equal(resolveGroup(current.groups.workflow, { native: current.config }).model, 'fixture/next');
  const groupPlan = planChange(current, {
    kind: 'group',
    name: 'developers',
    choice: { modelRef: 'opencode:small_model' },
  });
  await savePlan(groupPlan);
  assert.deepEqual((await loadSnapshot(root)).groups.developers, { modelRef: 'opencode:small_model' });
});

test('bulk updates preserve links and referenced presets cannot be deleted', async (t) => {
  const root = await fixture(t);
  let snapshot = await loadSnapshot(root);
  assert.throws(() => planChange(snapshot, { kind: 'deletePreset', name: 'balanced' }), /Reassign/);
  await savePlan(planChange(snapshot, { kind: 'deletePreset', name: 'unused' }));
  snapshot = await loadSnapshot(root);
  assert.equal(snapshot.modelPresets.unused, undefined);
  await savePlan(planChange(snapshot, { kind: 'all', choice: { model: 'fixture/next', variant: 'low' } }));
  snapshot = await loadSnapshot(root);
  assert.equal(snapshot.config.model, 'fixture/next');
  assert.equal(snapshot.config.small_model, 'fixture/next');
  assert.deepEqual(snapshot.modelPresets.balanced, { model: 'fixture/next', variant: 'low' });
  for (const name of ['developers', 'reviewers', 'workflow', 'system'] as const) {
    assert.equal(snapshot.groups[name].modelRef, options.groups[name].modelRef);
    assert.equal(snapshot.groups[name].model, undefined);
    assert.equal(snapshot.groups[name].variant, 'low');
  }
  assert.deepEqual(snapshot.groups.fallback, { model: 'fixture/next', variant: 'low' });
  assert.equal(snapshot.agents.find((agent) => agent.name === 'pinned')!.settings.model, 'fixture/small');
});

test('validation includes variants on linked groups and unpinned agents', async (t) => {
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  const preset = planChange(snapshot, { kind: 'preset', name: 'balanced', choice: { model: 'fixture/small' } });
  await assert.rejects(
    async () => (await plannedChoices(preset)).forEach((choice) => validateChoice(choice, catalog)),
    /variant/,
  );
  assert.equal(await readFile(snapshot.configFile.path, 'utf8'), snapshot.configFile.text);
  await writeFile(
    snapshot.configFile.path,
    JSON.stringify({
      plugin: [packageName],
      model: 'fixture/fast',
    }),
  );
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: { developers: { configuration: { modelRef: 'opencode:model' } } },
      profiles: { work: { layers: [{ componentGroup: 'developers' }] } },
      activeProfiles: ['work'],
    }),
  );
  const agentOnly = await loadSnapshot(root);
  assert.deepEqual(
    agentOnly.agents
      .filter((agent) => agent.markdown !== undefined)
      .map((agent) => [agent.name, agent.settings.variant]),
    [['extra', 'low']],
  );
  validateChoice(resolveGroup(agentOnly.groups.developers, { native: { model: 'fixture/small' } }), catalog);
  const global = planChange(agentOnly, { kind: 'global', field: 'model', model: 'fixture/small' });
  await assert.rejects(
    async () => (await plannedChoices(global)).forEach((choice) => validateChoice(choice, catalog)),
    /variant/,
  );
  assert.equal(await readFile(agentOnly.configFile.path, 'utf8'), agentOnly.configFile.text);
});

function uiHarness(root: string) {
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
  let dialog: SelectDialog | ConfirmDialog | PromptDialog | undefined;
  let onClose: (() => void) | undefined;
  const clear = () => {
    onClose?.();
    onClose = undefined;
    dialog = undefined;
  };
  let workspace: NativeModels | undefined;
  let providerError = false;
  const commands: { name: string; run: () => void | Promise<void> }[] = [];
  const toasts: { message: string }[] = [];
  const api = {
    state: { path: { config: root } },
    route: { current: { name: 'home' } },
    lifecycle: { signal: new AbortController().signal, onDispose: () => {} },
    keymap: {
      registerLayer: (layer: { commands: typeof commands }) => {
        commands.push(...layer.commands);
        return () => {};
      },
    },
    ui: {
      DialogSelect: (props: SelectDialog) => {
        dialog = props;
      },
      DialogConfirm: (props: ConfirmDialog) => {
        dialog = props;
      },
      DialogPrompt: (props: PromptDialog) => {
        dialog = props;
      },
      dialog: {
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
      file: {
        read: async (input: { path: string }) => ({
          data: { type: 'text', content: await readFile(input.path, 'utf8') },
        }),
      },
      config: {
        get: async () => ({ data: workspace ?? parseConfig(await readFile(join(root, 'opencode.jsonc'), 'utf8')) }),
        providers: async () => (providerError ? { error: {} } : { data: { providers } }),
      },
    },
  } as unknown as TuiPluginApi;
  registerSettings(api, root, root);
  return {
    get dialog() {
      return dialog;
    },
    get toasts() {
      return toasts;
    },
    setNative(value: NativeModels) {
      workspace = value;
    },
    setProviderError(value: boolean) {
      providerError = value;
    },
    async command() {
      await commands.find((command) => command.name === 'config-composer.models')!.run();
    },
    async select(value: string) {
      assert.ok(dialog !== undefined && 'options' in dialog);
      const option = dialog.options.find((option) => option.value === value);
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
  };
}

test('TUI can replace a malformed saved global model from the global defaults menu', async (t) => {
  const root = await fixture(t);
  const snapshot = await loadSnapshot(root);
  await writeFile(snapshot.configFile.path, JSON.stringify({ ...snapshot.config, model: 'invalid' }, null, 2));
  const ui = uiHarness(root);
  await ui.command();
  await ui.select('+global');
  assert.ok(ui.dialog !== undefined && 'options' in ui.dialog);
  assert.equal(ui.dialog.options.find((option) => option.value === 'model')?.description, 'invalid');
  await ui.select('model');
  await ui.select('fixture/next');
  assert.notEqual(ui.dialog, undefined);
  assert.equal(ui.dialog.title, 'Save agent settings?');
  assert.equal((await loadSnapshot(root)).config.model, 'invalid');
  await ui.confirm();
  assert.equal((await loadSnapshot(root)).config.model, 'fixture/next');
  assert.equal(ui.toasts.length, 0);
});

test('TUI preset creation returns through variants, models, and the name prompt without writing on cancellation', async (t) => {
  const root = await fixture(t);
  const original = await readFile(join(root, 'opencode.jsonc'), 'utf8');
  const ui = uiHarness(root);
  await ui.command();
  await ui.select('+presets');
  await ui.select('+');
  await ui.enter('cancelled-preset');
  await ui.select('fixture/next');
  await ui.select('high');
  await ui.cancel();
  assert.equal(ui.dialog?.title, 'Next: variant');
  await ui.select('\u0000back');
  assert.notEqual(ui.dialog, undefined);
  assert.equal(ui.dialog.title, 'cancelled-preset');
  await ui.escape();
  assert.notEqual(ui.dialog, undefined);
  assert.equal(ui.dialog.title, 'New model preset');
  assert.equal((ui.dialog as TuiDialogPromptProps).value, 'cancelled-preset');
  await ui.escape();
  assert.notEqual(ui.dialog, undefined);
  assert.equal(ui.dialog.title, 'Model presets');
  await ui.escape();
  assert.notEqual(ui.dialog, undefined);
  assert.equal(ui.dialog.title, 'Agent models: scope');
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), original);
});

test('TUI Back returns from native and preset reference variants to their model source menu', async (t) => {
  const root = await fixture(t);
  const original = await readFile(join(root, 'opencode.jsonc'), 'utf8');
  const ui = uiHarness(root);
  for (const reference of ['opencode:model', 'opencode:small_model', 'preset:balanced']) {
    await ui.command();
    await ui.select('developers');
    await ui.select(reference);
    if (reference === 'opencode:small_model') {
      assert.equal(ui.dialog?.title, 'Save agent settings?');
      await ui.cancel();
    } else {
      assert.ok(ui.dialog?.title.includes(reference) === true);
      await ui.select('\u0000back');
    }
    assert.notEqual(ui.dialog, undefined);
    assert.equal(ui.dialog.title, 'Group: developers · model source');
    await ui.escape();
    assert.notEqual(ui.dialog, undefined);
    assert.equal(ui.dialog.title, 'Agent models: scope');
  }
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), original);
});

test('TUI saves an effective workspace reference, shows its source, and preserves explicit pins', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  ui.setNative(context.native);
  await ui.command();
  assert.ok(ui.dialog !== undefined && 'options' in ui.dialog);
  assert.match(
    String(ui.dialog.options.find((option) => option.value === 'workflow')?.description),
    /opencode:model → fixture\/next.*running workspace differs/,
  );
  await ui.select('developers');
  await ui.select('opencode:model');
  await ui.select('low');
  assert.notEqual(ui.dialog, undefined);
  assert.ok('message' in ui.dialog && typeof ui.dialog.message === 'string');
  assert.match(ui.dialog.message, /opencode:model → fixture\/next/);
  assert.match(ui.dialog.message, /1 explicit model overrides/);
  await ui.confirm();
  const snapshot = await loadSnapshot(root);
  assert.deepEqual(snapshot.groups.developers, { modelRef: 'opencode:model', variant: 'low' });
  assert.equal(snapshot.agents.find((agent) => agent.name === 'pinned')!.settings.model, 'fixture/small');
});

test('TUI blocks stale effective defaults and unavailable catalogs before writing', async (t) => {
  const root = await fixture(t);
  const original = await readFile(join(root, 'opencode.jsonc'), 'utf8');
  const ui = uiHarness(root);
  await ui.command();
  await ui.select('developers');
  await ui.select('opencode:model');
  await ui.select('low');
  ui.setNative(context.native);
  await ui.confirm();
  assert.match(ui.toasts.at(-1)!.message, /Effective model defaults changed/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), original);
  await ui.command();
  await ui.select('developers');
  await ui.select('preset:balanced');
  await ui.select('');
  ui.setProviderError(true);
  await ui.confirm();
  assert.match(ui.toasts.at(-1)!.message, /Could not load provider models/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), original);
});

test('TUI creates, links, and edits a preset, and refuses deletion while referenced', async (t) => {
  const root = await fixture(t);
  const ui = uiHarness(root);
  await ui.command();
  await ui.select('+presets');
  await ui.select('+');
  await ui.enter('custom');
  await ui.select('fixture/next');
  await ui.select('high');
  await ui.confirm();
  await ui.select('later');
  assert.deepEqual((await loadSnapshot(root)).modelPresets.custom, { model: 'fixture/next', variant: 'high' });
  await ui.command();
  await ui.select('developers');
  await ui.select('preset:custom');
  await ui.select('');
  await ui.confirm();
  await ui.select('later');
  assert.deepEqual((await loadSnapshot(root)).groups.developers, { modelRef: 'preset:custom' });
  await ui.command();
  await ui.select('+presets');
  await ui.select('custom');
  await ui.select('delete');
  assert.match(ui.toasts.at(-1)!.message, /Reassign/);
  await ui.select('model');
  await ui.select('fixture/fast');
  await ui.select('low');
  await ui.confirm();
  const snapshot = await loadSnapshot(root);
  assert.deepEqual(snapshot.groups.developers, { modelRef: 'preset:custom' });
  assert.deepEqual(snapshot.modelPresets.custom, { model: 'fixture/fast', variant: 'low' });
});

test('TUI flags an unset native slot and validates inherited variants before saving', async (t) => {
  const root = await fixture(t);
  const original = await readFile(join(root, 'opencode.jsonc'), 'utf8');
  const ui = uiHarness(root);
  ui.setNative({ model: 'fixture/fast' });
  await ui.command();
  await ui.select('developers');
  await ui.select('opencode:small_model');
  assert.match(ui.toasts.at(-1)!.message, /no configured model/);
  await ui.command();
  await ui.select('+presets');
  await ui.select('balanced');
  await ui.select('model');
  await ui.select('fixture/small');
  await ui.confirm();
  assert.match(ui.toasts.at(-1)!.message, /variant/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), original);
});

test('TUI resolves indirect native preset references against the running workspace and rechecks them before saving', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'agents/extra.md'));
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    JSON.stringify({
      configurationPresets: { native: { modelRef: 'opencode:model' }, balanced: { modelRef: 'preset:native' } },
      componentGroups: { developers: { configuration: { model: 'fixture/fast' } }, reviewers: {}, workflow: {} },
      profiles: { work: { layers: [{ componentGroup: 'developers' }] } },
      activeProfiles: ['work'],
    }),
  );
  const original = await readFile(path, 'utf8');
  const ui = uiHarness(root);
  ui.setNative({ model: 'fixture/small' });
  await ui.command();
  await ui.select('developers');
  assert.ok(ui.dialog !== undefined && 'options' in ui.dialog);
  assert.match(ui.dialog.options.find((option) => option.value === 'preset:balanced')!.description!, /fixture\/small/);
  await ui.select('preset:balanced');
  assert.equal(ui.dialog.title, 'Save agent settings?', 'the running model has no variants to offer');
  ui.setNative({ model: 'fixture/next' });
  await ui.confirm();
  assert.match(ui.toasts.at(-1)!.message, /Effective model defaults changed/);
  assert.equal(await readFile(path, 'utf8'), original);
  ui.setNative({ model: 'fixture/small' });
  await ui.command();
  await ui.select('developers');
  await ui.select('preset:balanced');
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root)).groups.developers, { modelRef: 'preset:balanced' });
});

test('TUI opens and saves active native references when only the running workspace supplies the model', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'agents/extra.md'));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: { work: { agents: ['build'], configuration: { modelRef: 'opencode:model' } } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const ui = uiHarness(root);
  ui.setNative({ model: 'fixture/fast' });
  await ui.command();
  assert.ok(ui.dialog !== undefined && 'options' in ui.dialog);
  assert.match(ui.dialog.options.find((option) => option.value === 'work')!.description!, /fixture\/fast/);
  await ui.select('work');
  await ui.select('opencode:model');
  await ui.select('low');
  await ui.confirm();
  assert.deepEqual((await loadSnapshot(root, root, { model: 'fixture/fast' })).groups.work, {
    modelRef: 'opencode:model',
    variant: 'low',
  });
  assert.equal(ui.toasts.length, 0);
});
