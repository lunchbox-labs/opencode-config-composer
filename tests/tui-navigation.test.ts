import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  TuiDialogAlertProps,
  TuiDialogConfirmProps,
  TuiDialogPromptProps,
  TuiDialogSelectProps,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui';
import { type DialogDecoration, dialogNavigation } from '../src/tui/navigation.ts';

type Dialog = TuiDialogSelectProps<string> | TuiDialogAlertProps | TuiDialogConfirmProps | TuiDialogPromptProps;

function harness(decoration?: DialogDecoration) {
  let current: Dialog | undefined;
  let closed: (() => void) | undefined;
  let renders = 0;
  const controller = new AbortController();
  const render = (props: Dialog) => {
    renders++;
    current = props;
  };
  const api = {
    lifecycle: { signal: controller.signal },
    client: {},
    route: { current: { name: 'session', params: { sessionID: 'first' } } },
    ui: {
      DialogSelect: render,
      DialogAlert: render,
      DialogConfirm: render,
      DialogPrompt: render,
      dialog: {
        get open() {
          return current !== undefined;
        },
        replace: (next: () => void, onClose?: () => void) => {
          closed?.();
          closed = onClose;
          next();
        },
        // V1 invokes onClose before removing the current dialog.
        clear: () => {
          closed?.();
          closed = undefined;
          current = undefined;
        },
      },
    },
  } as unknown as TuiPluginApi;
  return {
    api,
    navigation: dialogNavigation(api, decoration),
    controller,
    get renders() {
      return renders;
    },
    get current() {
      return current;
    },
    async escape() {
      api.ui.dialog.clear();
      await Promise.resolve();
    },
  };
}

test('the close control clears every frame without restoring a parent', async () => {
  let close: () => void = () => assert.fail('The close control was not rendered');
  const view = harness((element, dismiss) => {
    close = dismiss;
    return element;
  });
  const nav = view.navigation;
  nav.menu({ title: 'Workflow', options: [] }, true);
  nav.menu({ title: 'Assignment', options: [] });
  nav.alert({ title: 'Prompt', message: 'Original assignment' });
  assert.equal(nav.canGoBack, true);
  close();
  await Promise.resolve();
  assert.equal(view.current, undefined);
  assert.equal(nav.canGoBack, false);
  nav.menu({ title: 'Workflow reopened', options: [] }, true);
  await view.escape();
  assert.equal(view.current, undefined);
});

test("nested menus offer Back and restore the parent's selection and live options", async () => {
  const view = harness();
  const nav = view.navigation;
  let title = 'Before';
  nav.menu(
    {
      title: 'Root',
      get options() {
        return [{ title, value: 'item' }];
      },
      onSelect: () => nav.menu({ title: 'Child', options: [] }),
    },
    true,
  );
  const root = view.current as TuiDialogSelectProps<string>;
  assert.equal(root.options.length, 1);
  root.onSelect!(root.options[0]);
  const child = view.current as TuiDialogSelectProps<string>;
  assert.equal(child.options.at(-1)?.title, '← Back');
  title = 'After';
  child.onSelect!(child.options.at(-1)!);
  assert.equal(view.current?.title, 'Root');
  assert.equal((view.current as TuiDialogSelectProps<string>).current, 'item');
  assert.equal((view.current as TuiDialogSelectProps<string>).options[0].title, 'After');
  await view.escape();
  assert.equal(view.current, undefined);
  assert.equal(nav.canGoBack, false);
});

test('Escape and native OK return through prompts and alerts without repeating actions', async () => {
  const view = harness();
  const nav = view.navigation;
  let submitted = 0;
  nav.menu({ title: 'Root', options: [] }, true);
  nav.prompt({
    title: 'Label',
    value: '',
    onConfirm: () => {
      submitted++;
      nav.alert({ title: 'Preview', message: 'Review' });
    },
  });
  (view.current as TuiDialogPromptProps).onConfirm!('Remember this');
  assert.equal(view.current?.title, 'Preview');
  (view.current as TuiDialogAlertProps).onConfirm?.();
  await view.escape();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Escape can replace or clear the captured dialog.
  assert.equal(view.current?.title, 'Label');
  assert.equal((view.current as TuiDialogPromptProps).value, 'Remember this');
  await view.escape();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Escape can replace or clear the captured dialog.
  assert.equal(view.current?.title, 'Root');
  assert.equal(submitted, 1);
});

test('a deferred confirmation can replace navigation without the native clear erasing its result', async () => {
  const view = harness();
  const nav = view.navigation;
  const deferred: Promise<void>[] = [];
  nav.menu({ title: 'Root', options: [] }, true);
  nav.confirm({
    title: 'Save?',
    message: 'Review',
    onConfirm: () => {
      deferred.push(Promise.resolve().then(() => nav.menu({ title: 'Saved', options: [] }, true)));
    },
  });
  (view.current as TuiDialogConfirmProps).onConfirm!();
  await view.escape();
  await Promise.all(deferred);
  assert.equal(view.current?.title, 'Saved');
  assert.equal(nav.canGoBack, false);
  await view.escape();
  assert.equal(view.current, undefined);
});

test('closing a panel never resurrects parents after another dialog, route, client, or lifecycle takes over', async () => {
  for (const change of ['dialog', 'route', 'client', 'abort', 'close'] as const) {
    const view = harness();
    const nav = view.navigation;
    nav.menu({ title: 'Root', options: [] }, true);
    nav.alert({ title: 'Child', message: 'Details' });
    view.api.ui.dialog.clear();
    if (change === 'dialog') {
      view.api.ui.dialog.replace(() => view.api.ui.DialogAlert({ title: 'Other', message: '' }));
    }
    if (change === 'route' && view.api.route.current.name === 'session') {
      view.api.route.current.params!.sessionID = 'second';
    }
    if (change === 'client') {
      Object.assign(view.api, { client: {} });
    }
    if (change === 'abort') {
      view.controller.abort();
    }
    if (change === 'close') {
      nav.close();
    }
    await Promise.resolve();
    assert.equal(view.current?.title, change === 'dialog' ? 'Other' : undefined, change);
    assert.equal(nav.canGoBack, false, change);
  }
});

test('refresh never resurrects a view after another dialog, route or client takes over', async () => {
  for (const change of ['dialog', 'route', 'client'] as const) {
    const view = harness();
    view.navigation.menu({ title: 'Editor', options: [] }, true);
    if (change === 'dialog') {
      view.api.ui.dialog.replace(() => view.api.ui.DialogAlert({ title: 'Other', message: '' }));
    }
    if (change === 'route') {
      Object.assign(view.api.route, { current: { name: 'home' } });
    }
    if (change === 'client') {
      Object.assign(view.api, { client: {} });
    }
    const before = view.renders;
    view.navigation.refresh();
    assert.equal(view.renders, before);
    assert.equal(view.current?.title, change === 'dialog' ? 'Other' : 'Editor');
    // A refresh must not create a fresh checkpoint that legitimizes the stale frame.
    await view.escape();
    assert.equal(view.current, undefined);
  }
});

test('definition settings Back returns to its exact definition and route changes discard child frames', async (t) => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { loadSnapshot } = await import('../src/config-composer/storage.ts');
  const { openAuthoring } = await import('../src/config-composer/tui/authoring.ts');
  const { openParameters } = await import('../src/config-composer/tui/parameters.ts');
  const root = await mkdtemp(join(tmpdir(), 'definition-navigation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({ componentGroups: { work: {} }, profiles: { work: {} } }),
  );
  const { packageName } = await import('../src/config-composer/package-name.ts');
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  const snapshot = await loadSnapshot(root);
  const view = harness();
  type AuthoringUi = Parameters<typeof openAuthoring>[1];
  const menu: AuthoringUi['menu'] = (title, options) => {
    const choices = typeof options === 'function' ? options() : options;
    view.navigation.menu({
      title,
      options: choices,
      onSelect: (option) => {
        Promise.resolve(choices.find((item) => item.value === option.value)?.run()).catch((error: unknown) => {
          assert.fail(String(error));
        });
      },
    });
  };
  const ui: AuthoringUi = {
    menu,
    prompt: () => {},
    back: view.navigation.back,
    refresh: view.navigation.refresh,
    groupModel: () => {},
    presetModel: () => {},
    createPreset: () => {},
    propose: async () => {},
    parameters: (target) => openParameters(snapshot, { menu, prompt: () => {}, propose: async () => {} }, target),
  };
  const choose = (value: string) => {
    const current = view.current as TuiDialogSelectProps<string>;
    const option = current.options.find((item) => item.value === value);
    assert.ok(option !== undefined);
    current.onSelect!(option);
  };
  openAuthoring(snapshot, ui);
  choose('+find');
  choose('componentGroups:work');
  choose('+parameters');
  assert.equal(view.current?.title, 'Group: work: parameters saved here');
  await view.escape();
  assert.equal(view.current.title, 'Component groups: work');
  choose('+parameters');
  (view.api.route.current as { params: { sessionID: string } }).params.sessionID = 'other';
  await view.escape();
  assert.equal(view.current, undefined);
  assert.equal(view.navigation.canGoBack, false);
});
