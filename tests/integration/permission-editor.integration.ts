import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { compositionFixture } from './composition-fixture.ts';
import { contentEditor } from './content-editor.ts';

test(
  'installed permission editor preserves ordered configured decisions and provenance without claiming native compilation',
  { timeout: 180_000 },
  async (t) => {
    const f = await compositionFixture(t, 'permission-editor');
    await f.write(f.paths.shared, {
      configurationPresets: { rules: { permissions: [] } },
      componentGroups: { work: { agents: ['worker'] } },
      profiles: {
        work: {
          layers: [{ componentGroup: 'work' }, { configurationPreset: 'rules', target: { agents: ['worker'] } }],
        },
      },
    });
    await f.host.start();
    const original = await f.send();
    const e = await contentEditor(f);
    const running = JSON.stringify(await f.host.api('/agent'));
    const rules = [
      { tool: 'bash', pattern: 'git *', action: 'deny' },
      { tool: 'bash', pattern: 'git status', action: 'allow' },
      { tool: 'bash', pattern: 'npm *', action: 'ask' },
    ] as const;
    const set = async (value: unknown) => {
      const { snapshot, selected } = await e.target(f.paths.shared, 'Preset: rules');
      const plan = e.planPermissions(snapshot, selected, value);
      await e.save(plan);
    };
    await set(rules);
    const saved = await readFile(f.paths.shared, 'utf8');
    for (const value of [
      [{ tool: '', action: 'allow' }],
      [{ tool: 'bash', action: 'maybe' }],
      [{ tool: 'bash', pattern: 42, action: 'deny' }],
      [{ tool: 'bash', action: 'ask', extra: true }],
      undefined,
    ]) {
      await assert.rejects(set(value), /permission|field|preset/i);
      assert.equal(await readFile(f.paths.shared, 'utf8'), saved);
    }
    await f.saveScope('shared', { operation: 'selection', profiles: ['work'] });
    const snapshot = await f.editor.snapshot();
    const preview = (input: string) => e.previewPermission(snapshot.resolved.permissions, 'worker', 'bash', input);
    assert.equal(preview('git').action, 'deny');
    assert.equal(preview('git push').action, 'deny');
    const allowed = preview('git status');
    assert.equal(allowed.action, 'allow');
    assert.match(allowed.origin!.pointer, /configurationPresets\/rules\/permissions\/1\/action/);
    assert.ok(allowed.origin!.overwritten.some((item) => item.pointer.endsWith('/permissions/0/action')));
    assert.equal(preview('npm test').action, 'ask');
    assert.deepEqual(preview('other'), { fallback: 'native' });
    assert.deepEqual(e.previewPermission(snapshot.resolved.permissions, 'unselected', 'bash', 'git'), {
      fallback: 'native',
    });
    const { selected } = await e.target(f.paths.shared, 'Preset: rules');
    const reordered = e.planPermissions(snapshot, selected, [rules[1], rules[0], rules[2]]);
    assert.equal(
      e.previewPermission(
        (await f.editor.storage.previewFilePlan(reordered)).resolved.permissions,
        'worker',
        'bash',
        'git status',
      ).action,
      'deny',
    );
    assert.deepEqual(
      (await f.document(f.paths.shared)).configurationPresets!.rules.permissions,
      rules,
      'preview has no write side effect',
    );
    await e.save(reordered);
    await set([rules[1], { tool: 'bash', pattern: 'git *', action: 'allow' }]);
    assert.equal(
      e.previewPermission((await f.editor.snapshot()).resolved.permissions, 'worker', 'bash', 'git push').action,
      'allow',
    );
    await set([]);
    assert.deepEqual(e.previewPermission((await f.editor.snapshot()).resolved.permissions, 'worker', 'bash', 'git'), {
      fallback: 'native',
    });
    const current = await e.target(f.paths.shared, 'Group: work');
    await e.save(e.planPermissions(current.snapshot, current.selected, [rules[0]]));
    const reset = await e.target(f.paths.shared, 'Group: work');
    await e.save(e.planPermissions(reset.snapshot, reset.selected, undefined));
    assert.equal((await f.document(f.paths.shared)).componentGroups!.work.configuration?.permissions, undefined);
    const pending = await e.target(f.paths.shared, 'Preset: rules');
    const stale = e.planPermissions(pending.snapshot, pending.selected, rules);
    const concurrent = `${await readFile(f.paths.shared, 'utf8')}\n// concurrent change\n`;
    await writeFile(f.paths.shared, concurrent);
    await assert.rejects(e.save(stale), /changed/);
    assert.equal(await readFile(f.paths.shared, 'utf8'), concurrent);
    assert.match(concurrent, /Preserve fixture comments/);
    assert.equal(
      JSON.stringify(await f.host.api('/agent')),
      running,
      'configured edits do not mutate running native permissions',
    );
    assert.equal(f.host.requests.length, 1, 'configured matching sends no model requests');
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
  },
);
