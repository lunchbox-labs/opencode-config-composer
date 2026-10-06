import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { validateBaseline, validateCliVersion } from './opencode.mjs';
import { isolatedEnvironment } from '../tests/integration/harness.ts';

export function nativePackage(platform = process.platform, arch = process.arch) {
  assert.equal(arch, 'x64', 'the integration installer supports x64 runners');
  assert.ok(['linux', 'win32'].includes(platform), 'the integration suite supports Linux and Windows');
  return {
    name: platform === 'win32' ? 'opencode-windows-x64' : 'opencode-linux-x64',
    executable: platform === 'win32' ? 'opencode.exe' : 'opencode',
  };
}

async function main() {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const artifacts = join(repository, 'integration-results');
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts);
  const root = await mkdtemp(join(tmpdir(), 'composer runner '));
  let transcript = '';
  const run = async (command, args, options = {}) => {
    const child = spawn(command, args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    const capture = (data) => {
      const text = data.toString();
      process.stdout.write(text);
      transcript = (transcript + text).slice(-65_536);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`Command failed (${signal ?? code})`)),
      );
    });
  };
  try {
    const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(join(repository, 'package-lock.json'), 'utf8'));
    const version = validateBaseline(manifest, lock);
    let binary = process.env.OPENCODE_BIN;
    if (binary === undefined) {
      const target = nativePackage();
      assert.ok(process.env.npm_execpath, 'run this suite with npm run test:integration');
      await run(
        process.execPath,
        [
          process.env.npm_execpath,
          'install',
          '--prefix',
          root,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          `${target.name}@${version}`,
        ],
        { timeout: 120_000 },
      );
      binary = join(root, 'node_modules', target.name, 'bin', target.executable);
    }
    const { stdout } = await promisify(execFile)(binary, ['--version'], {
      env: isolatedEnvironment(root),
      timeout: 30_000,
    });
    validateCliVersion(stdout, version);
    console.log(
      `Native integration: ${process.platform}/${process.arch}, OpenCode ${version}, Node ${process.version}`,
    );
    await writeFile(
      join(artifacts, 'versions.json'),
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          opencode: version,
          node: process.version,
          package: manifest.version,
        },
        null,
        2,
      ),
    );
    await run(
      process.execPath,
      [
        '--experimental-strip-types',
        '--test',
        '--test-concurrency=1',
        '--test-timeout=300000',
        'tests/config-composer.native.ts',
        'tests/integration/lifecycle.integration.ts',
      ],
      {
        env: { ...process.env, OPENCODE_BIN: binary, INTEGRATION_ARTIFACT_DIR: artifacts },
        timeout: 480_000,
      },
    );
  } finally {
    await writeFile(join(artifacts, 'runner.log'), Buffer.from(transcript).subarray(-65_536));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
