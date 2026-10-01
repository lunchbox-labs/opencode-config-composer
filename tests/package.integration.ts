import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installPackage } from './install-package.ts';

test('the tarball runs outside the checkout with only production dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = await installPackage(root);
  const dependencies = await readdir(join(root, 'node_modules'));
  assert.ok(!dependencies.includes('@opencode-ai'));
  assert.ok(!dependencies.includes('@opentui'));
  assert.ok(!dependencies.includes('typescript'));
  await copyFile(new URL('./installed-consumer.mjs', import.meta.url), join(root, 'consumer.mjs'));
  const result = await promisify(execFile)(process.execPath, ['consumer.mjs', installed.name], { cwd: root });
  assert.match(result.stdout, /installed package verified/);
  // TypeScript consumers supply OpenCode's development types; runtime checks above use production dependencies only.
  for (const name of ['@opencode-ai', '@opentui', '@types', 'solid-js']) {
    await symlink(
      fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)),
      join(root, 'node_modules', name),
      'dir',
    );
  }
  await copyFile(new URL('./installed-declarations.ts', import.meta.url), join(root, 'consumer.ts'));
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        resolveJsonModule: true,
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ['consumer.ts'],
    }),
  );
  await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', join(root, 'tsconfig.json')],
    { cwd: root },
  );
});
