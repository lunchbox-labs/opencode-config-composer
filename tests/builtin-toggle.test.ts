import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TuiDialogSelectProps } from '@opencode-ai/plugin/tui';
import { openEffective } from '../src/config-composer/tui/effective.ts';
import type { Inspection } from '../src/config-composer/tui/inspection.ts';

type View = Parameters<typeof openEffective>[0];

test('the built-in agent toggle is remembered through api.kv', () => {
  const stored = new Map<string, unknown>();
  let current: TuiDialogSelectProps<string> | undefined;
  const api = {
    kv: {
      get: (key: string) => stored.get(key),
      set: (key: string, value: unknown) => {
        stored.set(key, value);
      },
    },
  } as unknown as View['api'];
  const nav = {
    menu: (props: TuiDialogSelectProps<string>) => {
      current = props;
    },
  } as unknown as View['nav'];
  const snapshot = {
    config: {},
    agents: [{ name: 'build', native: true }],
    commands: [],
    runtime: undefined,
  } as unknown as Inspection;
  const open = () =>
    openEffective({
      api,
      nav,
      run: (action) => {
        Promise.resolve(action()).catch(() => undefined);
      },
      details: () => {},
      snapshot,
    });
  const titles = () => current?.options.map((option) => option.title) ?? [];
  const choose = (title: string) => {
    const option = current?.options.find((item) => item.title === title);
    assert.ok(option !== undefined, title);
    current?.onSelect?.(option);
  };
  open();
  assert.ok(!titles().includes('agent build'));
  choose('Show built-in agents');
  assert.ok(titles().includes('agent build'));
  assert.equal(stored.get('config-composer.showBuiltins'), true);
  open();
  assert.ok(titles().includes('agent build'));
  choose('Hide built-in agents');
  assert.ok(!titles().includes('agent build'));
  assert.equal(stored.get('config-composer.showBuiltins'), false);
});

test('a host without a key-value store still opens the inspector', () => {
  let current: TuiDialogSelectProps<string> | undefined;
  openEffective({
    api: {} as unknown as View['api'],
    nav: {
      menu: (props: TuiDialogSelectProps<string>) => {
        current = props;
      },
    } as unknown as View['nav'],
    run: () => {},
    details: () => {},
    snapshot: { config: {}, agents: [], commands: [], runtime: undefined },
  });
  assert.equal(current?.title, 'Configuration');
});
