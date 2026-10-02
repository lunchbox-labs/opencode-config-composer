import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TuiDialogAlertProps, TuiDialogSelectProps, TuiPluginApi } from '@opencode-ai/plugin/tui';
import { registerSettings } from '../src/config-composer/tui.ts';
import { packageName } from '../src/config-composer/package-name.ts';

interface Command {
  name: string;
  slashName: string;
  run: () => void | Promise<void>;
}
function harness(root: string) {
  let dialog: TuiDialogSelectProps<string> | TuiDialogAlertProps | undefined;
  let closed: (() => void) | undefined;
  const commands: Command[] = [];
  const disposers: (() => void)[] = [];
  const controller = new AbortController();
  const toasts: unknown[] = [];
  let unregisterCalls = 0;
  const render = (props: NonNullable<typeof dialog>) => {
    dialog = props;
  };
  const api = {
    state: { path: { config: root } },
    route: { current: { name: 'home' } },
    lifecycle: { signal: controller.signal, onDispose: (dispose: () => void) => disposers.push(dispose) },
    keymap: {
      registerLayer: (layer: { commands: Command[] }) => {
        commands.push(...layer.commands);
        return () => {
          unregisterCalls++;
          layer.commands.forEach((command) => commands.splice(commands.indexOf(command), 1));
        };
      },
    },
    client: {
      file: {
        read: async ({ path }: { path: string }) => ({ data: { type: 'text', content: await readFile(path, 'utf8') } }),
      },
      config: {
        get: async () => ({
          data: {
            model: 'native/main',
            small_model: 'native/small',
            default_agent: 'build',
            provider: { secret: 'must-not-display' },
          },
        }),
      },
    },
    ui: {
      DialogSelect: render,
      DialogAlert: render,
      toast: (toast: unknown) => toasts.push(toast),
      dialog: {
        get open() {
          return dialog !== undefined;
        },
        replace: (next: () => void, onClose?: () => void) => {
          closed?.();
          closed = onClose;
          next();
        },
        clear: () => {
          closed?.();
          closed = undefined;
          dialog = undefined;
        },
      },
    },
  } as unknown as TuiPluginApi;
  return {
    api,
    commands,
    disposers,
    controller,
    toasts,
    get dialog() {
      return dialog;
    },
    get unregisterCalls() {
      return unregisterCalls;
    },
    async open(slashName: string) {
      const command = commands.find((item) => item.slashName === slashName);
      assert.ok(command !== undefined, `/${slashName} registered`);
      await command.run();
    },
    async select(value: string) {
      const props = dialog as TuiDialogSelectProps<string>;
      const option = props.options.find((item) => item.value === value);
      assert.ok(option !== undefined, `option ${value}`);
      await Promise.resolve(props.onSelect?.(option));
    },
    async escape() {
      api.ui.dialog.clear();
      await Promise.resolve();
    },
  };
}

test('compose opens registered supported sections', async () => {
  const view = harness('');
  // Import dynamically so the initial failure is the missing /compose registration, not a missing module.
  registerSettings(view.api);
  await view.open('compose');
  const sectionIds = (view.dialog as TuiDialogSelectProps<string>).options.map((option) => option.value);
  assert.deepEqual(sectionIds, ['effective', 'models', 'groups']);
  const { registerCompose } = await import('../src/config-composer/tui/compose.ts');
  const isolated = harness('');
  let opens = 0;
  const dispose = registerCompose(isolated.api, [
    {
      id: 'effective',
      title: 'Effective',
      open: () => {
        opens++;
      },
    },
  ]);
  await isolated.open('compose');
  await isolated.select('effective');
  assert.equal(opens, 1);
  dispose();
  dispose();
  const unregisterCalls = isolated.unregisterCalls;
  assert.equal(unregisterCalls, 1);
  assert.equal(isolated.commands.length, 0);
});

test('compose reuses model and group aliases with nested Back and Escape', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'compose-menu-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({ agent: { groups: { workers: { model: 'fixture/model' } } }, command: {}, skill: {} }),
  );
  const before = await readFile(join(root, 'config-composer.jsonc'), 'utf8');
  const view = harness(root);
  registerSettings(view.api, root, root);
  for (const [section, alias, title] of [
    ['models', 'agent-models', 'Agent models: scope'],
    ['groups', 'agent-groups', 'Agent groups'],
  ]) {
    await view.open('compose');
    await view.select(section);
    assert.equal((view.dialog as { title?: string } | undefined)?.title, title);
    await view.select('\u0000back');
    assert.equal((view.dialog as { title?: string } | undefined)?.title, 'Compose');
    await view.select(section);
    await view.escape();
    assert.equal((view.dialog as { title?: string } | undefined)?.title, 'Compose');
    await view.escape();
    assert.equal(view.dialog, undefined);
    await view.open(alias);
    assert.equal((view.dialog as { title?: string } | undefined)?.title, title);
    await view.escape();
    assert.equal(view.dialog, undefined);
  }
  await view.open('compose');
  await view.select('effective');
  const effective = view.dialog as TuiDialogSelectProps<string>;
  assert.equal(effective.title, 'Effective configuration and sources');
  assert.ok(effective.options.some((option) => option.description?.includes('native/main') === true));
  await view.select('/model');
  assert.match((view.dialog as TuiDialogAlertProps).message, /Effective native.*source file unavailable/s);
  assert.doesNotMatch((view.dialog as TuiDialogAlertProps).message, /opencode.json/);
  await view.escape();
  await view.select('/settings/groups/workers/model');
  assert.match((view.dialog as TuiDialogAlertProps).message, /Saved Composer.*config-composer.jsonc/s);
  assert.doesNotMatch(JSON.stringify(view.dialog), /must-not-display/);
  assert.equal(await readFile(join(root, 'config-composer.jsonc'), 'utf8'), before);
  assert.equal(view.toasts.length, 0);
  await view.escape();
  view.api.route.current.name = 'session';
  await view.escape();
  assert.equal(view.dialog, undefined);
  await view.open('compose');
  await view.select('groups');
  view.controller.abort();
  view.disposers.forEach((dispose) => dispose());
  await view.escape();
  assert.equal(view.dialog, undefined);
  assert.equal(view.commands.length, 0);
});

test('compose disposer preserves unrelated commands and ignores stale callbacks', async () => {
  const { registerCompose } = await import('../src/config-composer/tui/compose.ts');
  const view = harness('');
  const unrelated = { name: 'other.command', slashName: 'other', run: () => {} };
  view.commands.push(unrelated);
  let opens = 0;
  const dispose = registerCompose(view.api, [
    {
      id: 'models',
      title: 'Models',
      open: () => {
        opens++;
      },
    },
  ]);
  await view.open('compose');
  dispose();
  await view.select('models');
  assert.equal(opens, 0);
  assert.deepEqual(view.commands, [unrelated]);
});

test('closing compose while an effective read is pending does not reopen it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'compose-pending-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  await writeFile(join(root, 'config-composer.jsonc'), '{}');
  const view = harness(root);
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  view.api.client.config.get = (async () => {
    started?.();
    await pending;
    return { data: { model: 'native/main' } };
  }) as typeof view.api.client.config.get;
  registerSettings(view.api, root, root);
  await view.open('compose');
  const selection = view.select('effective');
  await reading;
  await view.escape();
  release?.();
  await selection;
  assert.equal(view.dialog, undefined);
});
