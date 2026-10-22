import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { nativeCommandPaths, observeNative } from '../src/config-composer/composition/revision.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-command-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commands = join(root, 'commands');
  const shared = join(root, 'shared');
  const alternate = join(root, 'alternate');
  await Promise.all([commands, shared, alternate].map((path) => mkdir(path)));
  // Identical bytes ensure a retarget is detected by identity, not only content.
  await Promise.all([shared, alternate].map((path) => writeFile(join(path, 'run.md'), 'Opaque command body')));
  const link = (target: string, path: string) =>
    symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  const context = {
    directory: root,
    worktree: root,
    home: root,
    environment: { XDG_CONFIG_HOME: root, OPENCODE_TEST_HOME: root, OPENCODE_CONFIG_DIR: root },
  };
  return { root, commands, shared, alternate, context, link };
}

test('command inventory preserves each lexical alias and detects additions and removals', async (t) => {
  const f = await fixture(t);
  const one = join(f.commands, 'one');
  const two = join(f.commands, 'two');
  await f.link(f.shared, one);
  const before = await observeNative(f.context);
  await f.link(f.shared, two);
  assert.deepEqual(await nativeCommandPaths(f.context), [join(one, 'run.md'), join(two, 'run.md')]);
  const added = await observeNative(f.context);
  assert.notEqual(added.commands, before.commands);
  await rm(two, { recursive: true });
  assert.deepEqual(await nativeCommandPaths(f.context), [join(one, 'run.md')]);
  assert.equal((await observeNative(f.context)).commands, before.commands);
});

test('command inventory detects an alias retarget even with identical command bytes', async (t) => {
  const f = await fixture(t);
  const alias = join(f.commands, 'alias');
  await f.link(f.shared, alias);
  const before = await observeNative(f.context);
  await rm(alias, { recursive: true });
  await f.link(f.alternate, alias);
  assert.deepEqual(await nativeCommandPaths(f.context), [join(alias, 'run.md')]);
  assert.notEqual((await observeNative(f.context)).commands, before.commands);
});

test('command inventory terminates ancestor cycles while retaining independent aliases', async (t) => {
  const f = await fixture(t);
  await f.link(f.shared, join(f.commands, 'one'));
  await f.link(f.shared, join(f.commands, 'two'));
  await f.link(f.shared, join(f.shared, 'self'));
  await f.link(f.commands, join(f.shared, 'parent'));
  assert.deepEqual(await nativeCommandPaths(f.context), [
    join(f.commands, 'one/run.md'),
    join(f.commands, 'two/run.md'),
  ]);
});

test('command inventory and hash are independent of directory enumeration order', async (t) => {
  const f = await fixture(t);
  await f.link(f.shared, join(f.commands, 'one'));
  await f.link(f.shared, join(f.commands, 'two'));
  await mkdir(join(f.commands, 'nested'));
  await writeFile(join(f.commands, 'nested/local.md'), 'Local body');
  const before = await observeNative(f.context);
  const paths = await nativeCommandPaths(f.context);
  const original = fs.promises.readdir;
  const mock = t.mock.method(fs.promises, 'readdir', async (...args: Parameters<typeof fs.promises.readdir>) =>
    (await original(...args)).reverse(),
  );
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  assert.deepEqual(await nativeCommandPaths(f.context), paths);
  assert.equal((await observeNative(f.context)).commands, before.commands);
});
