import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installPackage } from './install-package.ts';

// Prints the URL of every module resolved while importing the specifier in argv[1].
const recordImports = `
import { registerHooks } from 'node:module';
const urls = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    urls.push(result.url);
    return result;
  },
});
await import(process.argv[1]);
console.log(JSON.stringify(urls));
`;

test('the tarball runs outside the checkout with only production dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = await installPackage(root);
  const dependencies = await readdir(join(root, 'node_modules'));
  assert.ok(!dependencies.includes('@opencode-ai'));
  assert.ok(!dependencies.includes('@opentui'));
  assert.ok(!dependencies.includes('typescript'));
  assert.ok(!dependencies.includes('ajv'), 'schema validation is a development-only dependency');
  assert.deepEqual(await readdir(join(root, 'node_modules', '@lunchbox-labs')), ['opencode-config-composer']);
  await copyFile(new URL('./installed-consumer.mjs', import.meta.url), join(root, 'consumer.mjs'));
  const result = await promisify(execFile)(process.execPath, ['consumer.mjs', installed.name], { cwd: root });
  assert.match(result.stdout, /installed package verified/);
  // The host imports the TUI entry at startup. Frontmatter and JSONC parsing happen later, if at all.
  const startup = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', recordImports, `${installed.name}/tui`],
    { cwd: root },
  );
  const resolved = JSON.parse(startup.stdout) as string[];
  assert.ok(resolved.some((url) => url.endsWith('/dist/tui.js')));
  for (const parser of ['gray-matter', 'js-yaml', 'jsonc-parser']) {
    assert.ok(!resolved.some((url) => url.includes(`/node_modules/${parser}/`)), `the TUI entry imports ${parser}`);
  }
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
        types: ['node'],
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
