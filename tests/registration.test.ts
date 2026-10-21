import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serverEntry } from '../src/config-composer/registration.ts';
import { packageName } from '../src/config-composer/package-name.ts';

test('publication recognizes npm and canonical local package registrations', async (t) => {
  const directory = fileURLToPath(new URL('../', import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), 'composer-registration-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const alias = join(temporary, 'package');
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const spec of [
    packageName,
    `${packageName}@0.0.8`,
    directory,
    pathToFileURL(directory).href,
    alias,
    './package',
  ]) {
    assert.equal(serverEntry(spec, temporary), true, spec);
  }
  if (process.platform === 'win32') {
    assert.equal(serverEntry(directory.toUpperCase(), temporary), true);
  }
  assert.equal(serverEntry(temporary, temporary), false, 'an unrelated directory is not a write target');
});
