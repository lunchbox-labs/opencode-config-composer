import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageName } from '../src/config-composer/package-name.ts';
import { openAuthoring } from '../src/config-composer/tui/authoring.ts';
import { openPermissions } from '../src/config-composer/tui/permissions.ts';
import { planDefinition, previewDefinition } from '../src/config-composer/composition/authoring.ts';
import { planPermissions } from '../src/config-composer/composition/permission-authoring.ts';
import { loadSnapshot, previewFilePlan, saveFilePlan } from '../src/config-composer/storage.ts';

interface Action {
  title: string;
  value: string;
  run: () => void | Promise<void>;
}
interface Menu {
  title: string;
  actions: Action[] | (() => Action[]);
}
interface Prompt {
  title: string;
  value: string;
  confirm: (value: string) => void | Promise<void>;
}

for (const kind of ['layers', 'permissions'] as const) {
  test(`${kind}: move a selected occurrence to a validated position and save without changing other order`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'composer-move-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'config-composer.jsonc');
    const layers = [{ componentGroup: 'a' }, { componentGroup: 'b' }, { componentGroup: 'a' }, { componentGroup: 'c' }];
    const permissions = [
      { tool: 'bash', action: 'deny' },
      { tool: 'read', action: 'allow' },
      { tool: 'bash', action: 'deny' },
      { tool: '*', action: 'ask' },
    ];
    const source = JSON.stringify({
      componentGroups: { a: {}, b: {}, c: {} },
      profiles: { work: { layers } },
      configurationPresets: { checks: { permissions } },
    });
    await writeFile(path, source);
    await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
    const snapshot = await loadSnapshot(root);
    const frames: (Menu | Prompt)[] = [];
    let pending: unknown[] = [];
    let save: (() => Promise<unknown>) | undefined;
    const ui = {
      menu: (title: string, actions: Menu['actions']) => frames.push({ title, actions }),
      prompt: (title: string, value: string, confirm: Prompt['confirm']) => frames.push({ title, value, confirm }),
      back: () => {
        frames.pop();
      },
      refresh: () => {},
    };
    const select = async (value: string) => {
      const frame = frames.at(-1)!;
      assert.ok('actions' in frame);
      const actions = typeof frame.actions === 'function' ? frame.actions() : frame.actions;
      const action = actions.find((item) => item.value === value);
      assert.ok(action !== undefined, `${frame.title}: missing action ${value}`);
      await action.run();
    };
    const submit = async (text: string) => {
      const frame = frames.at(-1)!;
      assert.ok('confirm' in frame);
      await frame.confirm(text);
    };
    if (kind === 'layers') {
      openAuthoring(snapshot, {
        ...ui,
        groupModel: () => {},
        presetModel: () => {},
        createPreset: () => {},
        propose: async (_snapshot, change) => {
          assert.ok(change.operation === 'patch' && Array.isArray(change.value));
          pending = change.value;
          const plan = planDefinition(snapshot, change);
          await previewDefinition(plan);
          save = () => saveFilePlan(plan, async () => {});
        },
      });
      for (const value of ['profiles', 'work', 'layers']) {
        await select(value);
      }
    } else {
      openPermissions(snapshot, {
        ...ui,
        create: async () => {},
        preview: async () => {},
        propose: async (target, rules) => {
          pending = rules!;
          const plan = planPermissions(snapshot, target, rules);
          await previewFilePlan(plan);
          save = () => saveFilePlan(plan, async () => {});
        },
      });
      await select(path);
      await select(JSON.stringify(['configurationPresets', 'checks']));
    }
    await select('+save');
    const original = pending.slice();
    const listTitle = frames.at(-1)!.title;
    await select('2'); // Select the second equal-looking occurrence, using its underlying index.
    await select('position');
    const prompt = frames.at(-1)!;
    assert.ok('confirm' in prompt);
    assert.equal(prompt.value, '3');
    for (const invalid of ['', ' ', '0', '-1', '5', '1.5', '2x', '1e0', '0x2', 'Infinity', '9007199254740993']) {
      await assert.rejects(submit(invalid), /whole number from 1 to 4/i);
      assert.equal(frames.at(-1), prompt, 'invalid input leaves the same prompt open');
      assert.deepEqual(pending, original);
    }
    ui.back(); // Cancel the prompt, then back out of the occurrence menu.
    ui.back();
    assert.equal(frames.at(-1)!.title, listTitle);
    assert.deepEqual(pending, original);
    const move = async (index: number, position: string) => {
      await select(String(index));
      await select('position');
      await submit(position);
      assert.equal(frames.at(-1)!.title, listTitle);
    };
    await move(2, '1');
    assert.deepEqual(pending, [original[2], original[0], original[1], original[3]]);
    assert.equal(pending[0], original[2], 'the moved duplicate retains its identity');
    assert.equal(pending[1], original[0], 'the untouched duplicate retains its identity');
    await move(0, '4');
    assert.deepEqual(pending, [original[0], original[1], original[3], original[2]]);
    await move(3, ' 4 '); // Current position is a no-op; whitespace is harmless.
    assert.equal(pending[3], original[2]);
    await select('3');
    await select('earlier');
    await select('2');
    await select('later');
    assert.deepEqual(pending, [original[0], original[1], original[3], original[2]]);
    assert.equal(await readFile(path, 'utf8'), source, 'draft edits and previews never write');
    await select('+save');
    await save!();
    const saved = await loadSnapshot(root);
    assert.deepEqual(
      kind === 'layers'
        ? saved.sources.registry.profiles!.work.layers
        : saved.sources.registry.configurationPresets!.checks.permissions,
      pending,
    );
    // The existing save path still rejects edits based on an obsolete source snapshot.
    await select('+save');
    await assert.rejects(save!(), /changed/i);
  });
}
