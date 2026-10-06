import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageName } from '../src/config-composer/package-name.ts';
import {
  loadSnapshot,
  parseConfig,
  previewFilePlan,
  reloadConfiguration,
  saveFilePlan,
} from '../src/config-composer/storage.ts';
import { configurationTargets } from '../src/config-composer/composition/parameter-authoring.ts';
import {
  localPermissionRules,
  planPermissions,
  previewPermission,
} from '../src/config-composer/composition/permission-authoring.ts';

test('permission authoring preserves duplicate ordered rules, sibling fields and native files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-permission-editor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = JSON.stringify({ plugin: [packageName], permission: { bash: 'deny' } });
  await writeFile(join(root, 'opencode.jsonc'), native);
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    '{"configurationPresets":{"review":{"model":"fixture/model", /* retain */ "parameters":{"topP":0.8}}}}',
  );
  let snapshot = await loadSnapshot(root);
  let target = configurationTargets(snapshot, path).find((item) => item.label === 'Preset: review')!;
  const rules = [
    { tool: 'bash', pattern: 'git *', action: 'deny' as const },
    { tool: 'bash', pattern: 'git *', action: 'allow' as const },
  ];
  await saveFilePlan(planPermissions(snapshot, target, rules), async () => {});
  snapshot = await loadSnapshot(root);
  target = configurationTargets(snapshot, path).find((item) => item.label === 'Preset: review')!;
  assert.deepEqual(localPermissionRules(snapshot, target), rules);
  assert.match(await readFile(path, 'utf8'), /retain/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), native);
  await saveFilePlan(planPermissions(snapshot, target, undefined), async () => {});
  assert.equal(localPermissionRules(await loadSnapshot(root), target), undefined);
  const saved = parseConfig(await readFile(path, 'utf8'));
  assert.deepEqual(saved.configurationPresets, { review: { model: 'fixture/model', parameters: { topP: 0.8 } } });
});

test('configured permission preview keeps earlier matches until a later match wins, even when looser', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-permission-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [packageName], permission: { bash: 'deny' } }),
  );
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    JSON.stringify({
      defaults: { agents: { permissions: [{ tool: 'bash', pattern: 'git *', action: 'deny' }] } },
      componentGroups: {
        work: {
          agents: ['build'],
          configuration: { permissions: [{ tool: 'bash', pattern: 'npm *', action: 'ask' }] },
        },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const snapshot = await loadSnapshot(root);
  let updates = 0;
  await assert.rejects(
    reloadConfiguration(snapshot, async () => {
      updates++;
    }),
    /cannot apply/,
  );
  assert.equal(updates, 0);
  const target = configurationTargets(snapshot, path).find((item) => item.label === 'Group: work')!;
  assert.equal(previewPermission(snapshot.resolved.permissions, 'build', 'bash', 'git').action, 'deny');
  assert.equal(previewPermission(snapshot.resolved.permissions, 'build', 'bash', 'npm test').action, 'ask');
  assert.deepEqual(previewPermission(snapshot.resolved.permissions, 'build', 'edit', 'src/index.ts'), {
    fallback: 'native',
  });
  const plan = planPermissions(snapshot, target, [{ tool: 'bash', pattern: 'git *', action: 'allow' }]);
  const preview = await previewFilePlan(plan);
  const match = previewPermission(preview.resolved.permissions, 'build', 'bash', 'git status');
  assert.equal(match.action, 'allow');
  assert.equal(match.origin?.pointer, '/componentGroups/work/configuration/permissions/0/action');
  assert.equal(match.origin.sourceId, path);
  assert.equal(match.origin.overwritten.at(-1)?.pointer, '/defaults/agents/permissions/0/action');
  const empty = await previewFilePlan(planPermissions(snapshot, target, []));
  assert.equal(previewPermission(empty.resolved.permissions, 'build', 'bash', 'git').action, 'deny');
  assert.deepEqual(previewPermission(preview.resolved.permissions, 'plan', 'bash', 'git'), { fallback: 'native' });
});

test('permission edits reject invalid rules, forged targets, read-only destinations and stale sources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-permission-guards-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'shared'));
  await writeFile(join(root, 'shared/opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  const path = join(root, 'shared/config-composer.jsonc');
  const external = join(root, 'external.jsonc');
  await writeFile(external, '{"configurationPresets":{"external":{"permissions":[]}}}');
  await writeFile(path, '{"imports":["../external.jsonc"],"configurationPresets":{"review":{"permissions":[]}}}');
  const snapshot = await loadSnapshot(join(root, 'shared'));
  const target = configurationTargets(snapshot, path).find((item) => item.label === 'Preset: review')!;
  assert.throws(() => planPermissions(snapshot, target, undefined), /empty rule list|delete/);
  for (const rule of [
    { tool: '', action: 'allow' },
    { tool: 'bash', action: 'invalid' },
    { tool: 'bash', action: 'ask', unknown: true },
  ]) {
    assert.throws(() => planPermissions(snapshot, target, [rule]), /field|permission/i);
  }
  assert.throws(() => planPermissions(snapshot, { ...target, path: ['plugin'] }, []), /destination|target/);
  assert.throws(
    () => planPermissions(snapshot, { ...target, sourceId: external, path: ['configurationPresets', 'external'] }, []),
    /destination|target/,
  );
  const plan = planPermissions(snapshot, target, [{ tool: 'bash', action: 'ask' }]);
  await writeFile(path, '{}');
  await assert.rejects(
    saveFilePlan(plan, async () => {}),
    /changed/,
  );
  assert.equal(await readFile(path, 'utf8'), '{}');
});

test('configured wildcard previews preserve native matching semantics and bound complex inputs', () => {
  const preview = (pattern: string, input: string) =>
    previewPermission(
      [
        {
          agent: 'build',
          rule: { tool: 'ba?h', pattern, action: 'allow' },
          origin: {
            pointer: '/permissions/0/action',
            layer: 'test',
            operation: 'set',
            references: [],
            overwritten: [],
          },
        },
      ],
      'build',
      'bash',
      input,
    );
  for (const [pattern, input] of [
    ['git *', 'git'],
    ['file?.[txt]', 'file1.[txt]'],
    ['C:\\src\\*', 'C:/src/index.ts'],
    ['a?b', 'a\nb'],
    ['*', ''],
  ] as const) {
    assert.equal(preview(pattern, input).action, 'allow');
  }
  assert.deepEqual(preview('file?.[txt]', 'file1.txt'), { fallback: 'native' });
  assert.deepEqual(preview('git *', 'gitx'), { fallback: 'native' });
  assert.throws(() => preview(`*${'a'.repeat(2000)}b`, 'a'.repeat(10000)), /work limit/);
});
