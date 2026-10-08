import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type TestContext, test } from 'node:test';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';
import { loadSnapshot, previewFilePlan } from '../src/config-composer/storage.ts';
import { planDefinition } from '../src/config-composer/composition/authoring.ts';
import { packageName } from '../src/config-composer/package-name.ts';

async function fixture(t: TestContext, value: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'composer-shortcut-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode'));
  const file = join(root, 'config-composer.jsonc');
  await writeFile(file, JSON.stringify(value));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  return { root, file, context: { root, baseFile: file, baseExplicit: true } };
}

test('shortcut contracts accept ordered named profile selections and explicit none without choosing a write scope', () => {
  assert.deepEqual(
    readCompositionDocument({
      profileShortcuts: { code: { activeProfiles: ['work', 'review'] }, clear: { activeProfiles: [] } },
    }).profileShortcuts,
    { code: { activeProfiles: ['work', 'review'] }, clear: { activeProfiles: [] } },
  );
  for (const value of [
    {},
    { activeProfiles: ['same', 'same'] },
    { activeProfiles: ['./work.jsonc'] },
    { activeProfiles: [], scope: 'local' },
  ]) {
    assert.throws(() => readCompositionDocument({ profileShortcuts: { code: value } }), /profileShortcuts/);
  }
});

test('imported shortcuts preserve declaring origins and reject missing profiles, reserved names, command collisions and duplicate definitions', async (t) => {
  const f = await fixture(t, {
    imports: ['./shortcuts.jsonc'],
    profiles: { work: {}, review: {} },
    activeProfiles: ['review'],
  });
  const imported = join(f.root, 'shortcuts.jsonc');
  await writeFile(imported, JSON.stringify({ profileShortcuts: { code: { activeProfiles: ['work', 'review'] } } }));
  const loaded = await loadCompositionSources(f.context);
  assert.deepEqual(loaded.registry.profileShortcuts?.code.activeProfiles, ['work', 'review']);
  assert.deepEqual(loaded.activeProfiles, ['review'], 'declaring a shortcut never activates its profiles');
  assert.equal(loaded.provenance['/profileShortcuts/code'].sourceId, imported);
  for (const value of [
    { profileShortcuts: { code: { activeProfiles: ['missing'] } } },
    { profileShortcuts: { compose: { activeProfiles: [] } } },
    {
      profileShortcuts: { code: { activeProfiles: [] } },
      components: { commands: { code: { template: 'Not a profile action' } } },
    },
  ]) {
    await writeFile(imported, JSON.stringify(value));
    await assert.rejects(loadCompositionSources(f.context), /profileShortcuts/);
  }
  await writeFile(imported, JSON.stringify({ profileShortcuts: { code: { activeProfiles: [] } } }));
  await writeFile(
    f.file,
    JSON.stringify({ imports: ['./shortcuts.jsonc'], profileShortcuts: { code: { activeProfiles: [] } } }),
  );
  await assert.rejects(loadCompositionSources(f.context), /Duplicate definition.*profileShortcuts/);
});

test('profile rename rewrites shortcut references and referenced deletion is rejected', async (t) => {
  const f = await fixture(t, {
    profiles: { work: {}, review: {} },
    profileShortcuts: { code: { activeProfiles: ['work', 'review'] } },
  });
  const snapshot = await loadSnapshot(f.root);
  const renamed = await previewFilePlan(
    planDefinition(snapshot, { operation: 'rename', registry: 'profiles', name: 'work', nextName: 'coding' }),
  );
  assert.deepEqual(renamed.sources.registry.profileShortcuts?.code.activeProfiles, ['coding', 'review']);
  assert.throws(
    () => planDefinition(snapshot, { operation: 'delete', registry: 'profiles', name: 'work' }),
    /referenc/i,
  );
});
