import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { TuiDialogSelectProps, TuiPluginApi } from '@opencode-ai/plugin/tui';
import { type AuthoringUi, openAuthoring } from '../src/config-composer/tui/authoring.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { dialogNavigation } from '../src/tui/navigation.ts';
import { loadSnapshot, saveFilePlan } from '../src/config-composer/storage.ts';
import { planDefinition, previewDefinition } from '../src/config-composer/composition/authoring.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-targets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config-composer.jsonc');
  const layers = [
    { componentGroup: 'coding' },
    {
      configurationPreset: 'balanced',
      target: { agents: ['worker', 'missing', 'disabled'], componentGroups: ['tests', 'coding'] },
    },
    { componentGroup: 'tests' },
  ];
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({
      plugin: [packageName],
      agent: { worker: {}, helper: {}, outsider: {}, disabled: { disable: true } },
    }),
  );
  await writeFile(
    path,
    JSON.stringify({
      configurationPresets: { balanced: { model: 'fixture/a' } },
      componentGroups: { coding: { agents: ['worker', 'helper'] }, tests: {}, review: {} },
      profiles: { work: { layers }, other: { layers: [] } },
      activeProfiles: ['work'],
    }),
  );
  const snapshot = await loadSnapshot(root);
  let current: TuiDialogSelectProps<string>;
  let closed: (() => void) | undefined;
  let open = false;
  const api = {
    lifecycle: { signal: new AbortController().signal },
    client: {},
    route: { current: { name: 'home' } },
    ui: {
      DialogSelect: (props: TuiDialogSelectProps<string>) => {
        current = props;
      },
      dialog: {
        get open() {
          return open;
        },
        replace: (render: () => void, onClose: () => void) => {
          closed?.();
          closed = onClose;
          open = true;
          render();
        },
        clear: () => {
          closed?.();
          closed = undefined;
          open = false;
        },
      },
    },
  } as unknown as TuiPluginApi;
  const navigation = dialogNavigation(api);
  const ui: AuthoringUi = {
    menu: (title, actions) =>
      navigation.menu({
        title,
        get options() {
          return typeof actions === 'function' ? actions() : actions;
        },
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- preserve callback completion for native dialog tests.
        onSelect: (option) =>
          (typeof actions === 'function' ? actions() : actions).find((action) => action.value === option.value)?.run(),
      }),
    prompt: () => {},
    back: navigation.back,
    refresh: navigation.refresh,
    propose: async (original, change) => {
      const plan = planDefinition(original, change);
      await previewDefinition(plan);
      await saveFilePlan(plan, async () => {
        await previewDefinition(plan);
      });
    },
    groupModel: () => {},
    presetModel: () => {},
    createPreset: () => {},
  };
  openAuthoring(snapshot, ui);
  const select = async (value: string) => {
    const option = current.options.find((option) => option.value === value);
    assert.ok(option !== undefined, `Missing ${value} in ${current.title}`);
    await (current.onSelect as (option: (typeof current.options)[number]) => unknown)(option);
  };
  for (const value of ['profiles', 'work', 'layers', '1', 'targets']) {
    await select(value);
  }
  return {
    path,
    layers,
    snapshot,
    select,
    navigation,
    get current() {
      return current;
    },
    escape: async () => {
      api.ui.dialog.clear();
      await Promise.resolve();
    },
    document: async () =>
      JSON.parse(await readFile(path, 'utf8')) as {
        profiles: { work: { layers: typeof layers }; other: { layers: unknown[] } };
        activeProfiles: string[];
      },
  };
}

test('target checklist preserves authored order, missing references, preset and layer position', async (t) => {
  const f = await fixture(t);
  assert.match(f.current.options.find((o) => o.value === 'agent:missing')!.description!, /unavailable|missing/i);
  assert.match(f.current.options.find((o) => o.value === 'agent:disabled')!.description!, /disabled/i);
  await f.select('agent:missing');
  await f.select('agent:missing');
  await f.select('agent:worker');
  await f.select('agent:worker');
  await f.select('group:tests');
  await f.select('group:tests');
  await f.select('agent:helper');
  await f.select('group:review');
  await f.select('+save');
  await f.select('\u0000back');
  await f.select('+save');
  const saved = await f.document();
  assert.deepEqual(saved.profiles.work.layers, [
    f.layers[0],
    {
      configurationPreset: 'balanced',
      target: { agents: ['worker', 'missing', 'disabled', 'helper'], componentGroups: ['tests', 'coding', 'review'] },
    },
    f.layers[2],
  ]);
  assert.deepEqual(saved.profiles.other, { layers: [] });
  assert.deepEqual(saved.activeProfiles, ['work']);
  assert.deepEqual(f.snapshot.sources.registry.profiles!.work.layers, f.layers);
});

test('native Escape and Back discard target drafts; empty union disables and guards Save', async (t) => {
  const f = await fixture(t);
  await f.select('agent:worker');
  await f.escape();
  await f.select('targets');
  assert.match(f.current.options.find((o) => o.value === 'agent:worker')!.title, /✓/);
  await f.select('group:review');
  await f.select('\u0000back');
  await f.select('targets');
  assert.doesNotMatch(f.current.options.find((o) => o.value === 'group:review')!.title, /✓/);
  for (const value of ['agent:worker', 'agent:missing', 'agent:disabled', 'group:tests', 'group:coding']) {
    await f.select(value);
  }
  assert.equal(f.current.options.find((o) => o.value === '+save')!.disabled, true);
  await f.select('+save');
  assert.match(f.current.title, /targets/);
  await f.escape();
  await f.select('\u0000back');
  await f.select('+save');
  assert.deepEqual((await f.document()).profiles.work.layers, f.layers);
});

test('target edits use the original snapshot to reject stale writes', async (t) => {
  const f = await fixture(t);
  await f.select('group:review');
  await f.select('+save');
  await f.select('\u0000back');
  const concurrent = (await readFile(f.path, 'utf8')) + '\n// concurrent edit';
  await writeFile(f.path, concurrent);
  await assert.rejects(f.select('+save'), /Settings changed/);
  assert.equal(await readFile(f.path, 'utf8'), concurrent);
});

test('target save retains selected-target validation before writing', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.path, 'utf8');
  await f.select('agent:outsider');
  await f.select('+save');
  await f.select('\u0000back');
  await assert.rejects(f.select('+save'), /must be selected before assigning preset/);
  assert.equal(await readFile(f.path, 'utf8'), before);
});
