import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSource } from '../src/config-composer/composition/sources.ts';
test('source loader rejects a symlink retarget during reading instead of mislabeling target bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-source-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a.jsonc');
  const b = join(root, 'b.jsonc');
  const path = join(root, 'config-composer.jsonc');
  await writeFile(a, '{"model":"p/a"}');
  await writeFile(b, '{"model":"p/b"}');
  await symlink(a, path);
  const original = fs.promises.lstat;
  let changed = false;
  const mocked = t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
    const result = await original(...args);
    if (String(args[0]) === path && !changed) {
      changed = true;
      await unlink(path);
      await symlink(b, path);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(loadSource({}, root), /source changed while loading/);
  assert.equal(changed, true);
});
test('implicit absence is empty but an explicit missing source is rejected; no project stack is loaded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode'));
  await writeFile(join(root, '.opencode/config-composer.jsonc'), 'invalid ignored project file');
  assert.deepEqual((await loadSource({}, root)).document, { groups: {}, profiles: {} });
  await assert.rejects(loadSource({ configFile: 'missing.jsonc' }, root), /Explicit.*does not exist/);
});
