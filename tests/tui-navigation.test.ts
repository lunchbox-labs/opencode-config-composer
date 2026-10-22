import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  TuiDialogAlertProps,
  TuiDialogConfirmProps,
  TuiDialogSelectProps,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui';
import { dialogNavigation } from '../src/tui/navigation.ts';

type Dialog = TuiDialogSelectProps<string> | TuiDialogAlertProps | TuiDialogConfirmProps;

function harness() {
  let current: Dialog | undefined;
  let closed: (() => void) | undefined;
  const controller = new AbortController();
  const render = (props: Dialog) => {
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
    navigation: dialogNavigation(api),
    controller,
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
  const view = harness();
  const nav = view.navigation;
  nav.menu({ title: 'Workflow', options: [] }, true);
  nav.menu({ title: 'Assignment', options: [] });
  nav.alert({ title: 'Prompt', message: 'Original assignment' });
  nav.close();
  await Promise.resolve();
  assert.equal(view.current, undefined);
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
});

test('Escape and native OK return through confirmations and alerts without repeating actions', async () => {
  const view = harness();
  const nav = view.navigation;
  let submitted = 0;
  nav.menu({ title: 'Root', options: [] }, true);
  nav.confirm({
    title: 'Label',
    message: 'Review',
    onConfirm: () => {
      submitted++;
      nav.alert({ title: 'Preview', message: 'Review' });
    },
  });
  (view.current as TuiDialogConfirmProps).onConfirm!();
  assert.equal(view.current?.title, 'Preview');
  (view.current as TuiDialogAlertProps).onConfirm?.();
  await view.escape();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Escape can replace or clear the captured dialog.
  assert.equal(view.current?.title, 'Label');
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
  }
});
