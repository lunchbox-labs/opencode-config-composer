import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { TuiPluginApi, TuiToast } from '@opencode-ai/plugin/tui';
import { createStore } from 'solid-js/store';
import { registerErrorNotice } from '../src/config-composer/tui/notice.ts';

function fixture(t: TestContext, diagnostic?: string) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = (message?: string, directory = '/project') => ({
    plugin:
      message === undefined
        ? []
        : [
            [
              'composer',
              {
                __configComposerRuntime: {
                  version: 2,
                  status: 'error',
                  location: { directory, root: directory },
                  diagnostic: message,
                },
              },
            ],
          ],
  });
  const [state, setState] = createStore({
    config: config(diagnostic),
    path: { directory: '/project', worktree: '/project' },
  });
  const controller = new AbortController();
  const toasts: TuiToast[] = [];
  const api = {
    state,
    lifecycle: { signal: controller.signal },
    ui: { toast: (toast: TuiToast) => toasts.push(toast) },
  } as unknown as TuiPluginApi;
  const dispose = registerErrorNotice(api);
  t.after(dispose);
  return { toasts, controller, dispose, setState, config };
}

test('notifies when config arrives after the former one-second check', (t) => {
  const f = fixture(t);
  t.mock.timers.tick(5000);
  f.setState('config', f.config('Late composition failure'));
  assert.deepEqual(f.toasts, [{ variant: 'error', title: 'Config Composer', message: 'Late composition failure' }]);
});

test('suppresses one ongoing error but not the same error after recovery', (t) => {
  const f = fixture(t, 'Invalid group');
  f.setState('config', f.config('Invalid group'));
  assert.equal(f.toasts.length, 1);
  f.setState('config', f.config());
  f.setState('config', f.config('Invalid group'));
  assert.equal(f.toasts.length, 2);
  f.setState('config', f.config('Missing profile'));
  assert.equal(f.toasts.at(-1)?.message, 'Missing profile');
});

test('same diagnostic in a different location is a new error', (t) => {
  const f = fixture(t, 'Invalid group');
  f.setState({ config: f.config('Invalid group', '/other'), path: { directory: '/other', worktree: '/' } });
  assert.equal(f.toasts.length, 2);
});

test('ignores markers for other locations and reacts when their location matches', (t) => {
  const f = fixture(t);
  f.setState('config', f.config('Other error', '/other'));
  assert.equal(f.toasts.length, 0);
  f.setState('path', { directory: '/other', worktree: '' });
  assert.equal(f.toasts.at(-1)?.message, 'Other error');
});

test('startup notices redact and truncate the published diagnostic', (t) => {
  const f = fixture(t, 'apiKey=PRIVATE_SENTINEL\n' + 'x'.repeat(10000));
  assert.equal(f.toasts.length, 1);
  assert.doesNotMatch(f.toasts[0].message, /PRIVATE_SENTINEL/);
  assert.ok(f.toasts[0].message.length < 6100);
  assert.match(f.toasts[0].message, /truncated/);
});

for (const stop of ['dispose', 'abort'] as const) {
  test(`stops notices after lifecycle ${stop}`, (t) => {
    const f = fixture(t);
    if (stop === 'abort') {
      f.controller.abort();
    } else {
      f.dispose();
    }
    f.setState('config', f.config('Disposed error'));
    t.mock.timers.tick(10000);
    assert.equal(f.toasts.length, 0);
  });
}
