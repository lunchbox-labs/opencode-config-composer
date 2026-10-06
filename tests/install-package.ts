import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const npm = process.env.npm_execpath;
assert.ok(npm !== undefined, 'run package/native tests through npm run');
const npmArgs = [npm];
const repository = fileURLToPath(new URL('../', import.meta.url));

export async function installPackage(root: string) {
  const output = join(root, 'tarballs');
  await mkdir(output, { recursive: true });
  const packed = await exec(
    process.execPath,
    [...npmArgs, 'pack', '--ignore-scripts', '--json', '--pack-destination', output],
    {
      cwd: repository,
      timeout: 30_000,
    },
  );
  const result = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
  assert.equal(result.length, 1);
  const files = result[0].files.map((file) => file.path);
  for (const required of [
    'package.json',
    'README.md',
    'schema.json',
    'LICENSE',
    'src/server.ts',
    'src/tui.ts',
    'tsconfig.json',
    'tsconfig.build.json',
    'dist/server.js',
    'dist/server.d.ts',
    'dist/tui.js',
    'dist/tui.d.ts',
    'dist/config-composer/server.js',
    'dist/config-composer/tui.js',
    'dist/tui/navigation.js',
  ]) {
    assert.ok(files.includes(required), `tarball missing ${required}`);
  }
  for (const path of files) {
    assert.match(
      path,
      /^(?:dist\/.*\.(?:js|d\.ts)|src\/.*\.ts|tsconfig(?:\.build)?\.json|package\.json|schema\.json|README\.md|LICENSE)$/,
      `unexpected published file: ${path}`,
    );
  }
  const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')) as { name: string };
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await exec(
    process.execPath,
    [
      ...npmArgs,
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      join(output, result[0].filename),
    ],
    { cwd: root, timeout: 120_000 },
  );
  const directory = join(root, 'node_modules', manifest.name);
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(metadata.name, '@lunchbox-labs/opencode-config-composer');
  assert.equal(metadata.license, 'MIT');
  const license = await readFile(join(directory, 'LICENSE'), 'utf8');
  assert.equal(license, await readFile(join(repository, 'LICENSE'), 'utf8'));
  assert.match(license, /^MIT License\r?\n\r?\nCopyright \(c\) 2026 Lunchbox Labs\r?\n/);
  assert.match(license, /The above copyright notice and this permission notice shall be included/);
  assert.match(await readFile(join(directory, 'README.md'), 'utf8'), /licensed under MIT/);
  assert.equal(metadata.bin, undefined, 'the package is a plugin, with no executable command');
  assert.equal(metadata.main, undefined, 'entrypoints are defined only by exports');
  assert.deepEqual(Object.keys(metadata.exports as Record<string, unknown>), [
    '.',
    './server',
    './tui',
    './schema.json',
  ]);
  assert.equal(
    await readFile(join(directory, 'schema.json'), 'utf8'),
    await readFile(join(repository, 'schema.json'), 'utf8'),
  );
  return { name: manifest.name, directory, files };
}
