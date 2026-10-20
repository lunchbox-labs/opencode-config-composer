import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import semver from 'semver';

const repository = new URL('../', import.meta.url);

export function validateBaseline(manifest, lock, testConfig) {
  const version = testConfig.floor;
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, 'test floor must pin an exact stable CLI version');
  assert.deepEqual(
    lock.packages[''].engines,
    manifest.engines,
    'lockfile engine declarations differ from package.json',
  );
  validateTestVersion(version, testConfig.range);
  for (const name of ['@opencode-ai/plugin', '@opencode-ai/sdk']) {
    const declared = manifest.devDependencies[name];
    assert.match(declared ?? '', /^\d+\.\d+\.\d+$/, `${name} must have an exact version`);
    assert.equal(lock.packages[''].devDependencies[name], declared, `${name} lockfile declaration differs`);
    assert.equal(lock.packages[`node_modules/${name}`].version, declared, `${name} locked version differs`);
  }
  return version;
}

export function validateTestVersion(version, range) {
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, 'test version must be exact');
  assert.ok(semver.validRange(range), 'tested host range must be a valid semver range');
  assert.ok(semver.satisfies(version, range), 'test version is outside the tested host range');
  return version;
}

export function validateCliVersion(actual, expected) {
  assert.equal(actual.trim(), expected, 'the native OpenCode binary differs from the selected exact test version');
}

export function npmInvocation(npm = process.env.npm_execpath, platform = process.platform) {
  if (npm !== undefined) {
    return { command: process.execPath, args: [npm] };
  }
  assert.notEqual(platform, 'win32', 'run native scripts through npm on Windows');
  return { command: 'npm', args: [] };
}

export async function publishedVersions() {
  const cache = await mkdtemp(join(tmpdir(), 'composer-registry-'));
  try {
    const npm = npmInvocation();
    const { stdout } = await promisify(execFile)(
      npm.command,
      [
        ...npm.args,
        'view',
        'opencode-ai',
        'versions',
        '--json',
        '--prefer-online',
        '--offline=false',
        '--prefer-offline=false',
        '--cache',
        cache,
      ],
      { timeout: 60_000, maxBuffer: 4_000_000 },
    );
    return JSON.parse(stdout);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

export async function resolveNativeVersion(testConfig, options = { override: process.env.OPENCODE_TEST_VERSION }) {
  const range = testConfig.range;
  assert.ok(semver.validRange(range), 'tested host range must be a valid semver range');
  if (options.override === 'minimum') {
    return validateTestVersion(testConfig.floor, range);
  }
  if (options.override !== undefined && options.override !== 'latest') {
    return validateTestVersion(options.override, range);
  }
  const versions = await (options.readVersions ?? publishedVersions)();
  assert.ok(
    Array.isArray(versions) && versions.every((version) => typeof version === 'string'),
    'published versions must be an array of strings',
  );
  const compatible = versions
    .filter(
      (version) => semver.valid(version) && semver.prerelease(version) === null && semver.satisfies(version, range),
    )
    .sort(semver.compare);
  assert.ok(compatible.length > 0, `no stable published OpenCode version satisfies ${range}`);
  return validateTestVersion(compatible.at(-1), range);
}

async function readBaseline() {
  const manifest = JSON.parse(await readFile(new URL('package.json', repository), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', repository), 'utf8'));
  const testConfig = JSON.parse(await readFile(new URL('tests/opencode.json', repository), 'utf8'));
  validateBaseline(manifest, lock, testConfig);
  return { manifest, testConfig, version: await resolveNativeVersion(testConfig) };
}

async function installCli(directory, version) {
  assert.equal(process.arch, 'x64', 'the native installer supports x64');
  assert.ok(['linux', 'win32'].includes(process.platform), 'the native installer supports Linux and Windows');
  const name = process.platform === 'win32' ? 'opencode-windows-x64' : 'opencode-linux-x64';
  const npm = npmInvocation();
  await run(npm.command, [
    ...npm.args,
    'install',
    '--prefix',
    directory,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `${name}@${version}`,
  ]);
  return join(directory, 'node_modules', name, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
}

async function verifyBinary(binary, version, root) {
  const { stdout } = await promisify(execFile)(binary, ['--version'], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
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
  const { manifest, testConfig, version } = await readBaseline();
  console.log(`Selected OpenCode ${version} satisfying test range ${testConfig.range}`);
  if (process.argv[2] === 'install') {
    assert.ok(process.argv[3], 'provide the temporary installation directory');
    const directory = resolve(process.argv[3]);
    const binary = await installCli(directory, version);
    const verification = await mkdtemp(join(tmpdir(), 'composer-cli-version-'));
    try {
      await verifyBinary(binary, version, verification);
    } finally {
      await rm(verification, { recursive: true, force: true });
    }
    if (process.env.GITHUB_OUTPUT !== undefined) {
      await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    }
    return;
  }
  assert.equal(process.argv[2], 'test', 'use install DIRECTORY or test');
  const root = await mkdtemp(join(tmpdir(), 'composer-native-'));
  try {
    const binary = process.env.OPENCODE_BIN ?? (await installCli(root, version));
    await verifyBinary(binary, version, root);
    console.log(
      `Native CLI ${version}; plugin types ${manifest.devDependencies['@opencode-ai/plugin']}; SDK types ${manifest.devDependencies['@opencode-ai/sdk']}`,
    );
    const tests = (await readdir(new URL('tests/', repository)))
      .filter((name) => name.endsWith('.native.ts'))
      .sort()
      .map((name) => fileURLToPath(new URL(`tests/${name}`, repository)));
    assert.ok(tests.length > 0, 'native checks are missing');
    await run(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=1', ...tests], {
      env: { ...process.env, OPENCODE_BIN: binary, OPENCODE_TEST_VERSION: version },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
