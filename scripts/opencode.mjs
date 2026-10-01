import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const repository = new URL('../', import.meta.url);

export function validateBaseline(manifest, lock) {
  const version = manifest.engines?.opencode;
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, 'engines.opencode must pin an exact stable CLI version');
  assert.equal(lock.packages[''].engines.opencode, version, 'lockfile host baseline differs from package.json');
  for (const name of ['@opencode-ai/plugin', '@opencode-ai/sdk']) {
    const declared = manifest.devDependencies[name];
    assert.match(declared ?? '', /^\d+\.\d+\.\d+$/, `${name} must have an exact version`);
    assert.equal(lock.packages[''].devDependencies[name], declared, `${name} lockfile declaration differs`);
    assert.equal(lock.packages[`node_modules/${name}`].version, declared, `${name} locked version differs`);
  }
  return version;
}

export function validateCliVersion(actual, expected) {
  assert.equal(actual.trim(), expected, 'the native OpenCode binary differs from engines.opencode');
}

async function readBaseline() {
  const manifest = JSON.parse(await readFile(new URL('package.json', repository), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', repository), 'utf8'));
  return { manifest, version: validateBaseline(manifest, lock) };
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} failed (${signal ?? code})`));
      }
    });
  });
}

async function main() {
  const { manifest, version } = await readBaseline();
  if (process.argv[2] === 'install') {
    assert.equal(process.platform, 'linux', 'the CI binary installer supports Linux x64');
    assert.equal(process.arch, 'x64', 'the CI binary installer supports Linux x64');
    assert.ok(process.argv[3], 'provide the temporary installation directory');
    await run('npm', [
      'install',
      '--prefix',
      resolve(process.argv[3]),
      '--no-audit',
      '--no-fund',
      `opencode-linux-x64@${version}`,
    ]);
    return;
  }
  assert.equal(process.argv[2], 'test', 'use install DIRECTORY or test');
  const binary = process.env.OPENCODE_BIN ?? 'opencode';
  const root = await mkdtemp(join(tmpdir(), 'composer-cli-version-'));
  try {
    const { stdout } = await promisify(execFile)(binary, ['--version'], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_STATE_HOME: join(root, 'state'),
        XDG_CACHE_HOME: join(root, 'cache'),
        OPENCODE_TEST_HOME: root,
        OPENCODE_DB: join(root, 'db.sqlite'),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
      timeout: 30_000,
    });
    validateCliVersion(stdout, version);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(
    `Native CLI ${version}; plugin types ${manifest.devDependencies['@opencode-ai/plugin']}; SDK types ${manifest.devDependencies['@opencode-ai/sdk']}`,
  );
  const tests = (await readdir(new URL('tests/', repository)))
    .filter((name) => name.endsWith('.native.ts'))
    .sort()
    .map((name) => fileURLToPath(new URL(`tests/${name}`, repository)));
  assert.ok(tests.length > 0, 'native checks are missing');
  await run(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=1', ...tests]);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
