import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { validateBaseline, validateCliVersion } from './opencode.mjs';
import { isolatedEnvironment } from '../tests/integration/harness.ts';
import { stopProcess } from '../tests/integration/process.ts';
import { cleanupProcesses, registerProcess } from '../tests/integration/resources.ts';

export function nativePackage(platform = process.platform, arch = process.arch) {
  assert.equal(arch, 'x64', 'the integration installer supports x64 runners');
  assert.ok(['linux', 'win32'].includes(platform), 'the integration suite supports Linux and Windows');
  return {
    name: platform === 'win32' ? 'opencode-windows-x64' : 'opencode-linux-x64',
    executable: platform === 'win32' ? 'opencode.exe' : 'opencode',
  };
}

// Match OpenCode 1.18.34's native ripgrep dependency, with release checksums.
// Preinstallation avoids an instance reload interrupting the host's cached download.
const ripgrepVersion = '15.1.0';
export function ripgrepPackage(platform = process.platform) {
  assert.ok(['linux', 'win32'].includes(platform), 'ripgrep requires Linux or Windows');
  return platform === 'win32'
    ? {
        target: 'x86_64-pc-windows-msvc',
        extension: 'zip',
        executable: 'rg.exe',
        sha256: '124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a',
      }
    : {
        target: 'x86_64-unknown-linux-musl',
        extension: 'tar.gz',
        executable: 'rg',
        sha256: '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599',
      };
}

function cancellationSignals(signal) {
  const controller = new AbortController();
  const handlers = ['SIGINT', 'SIGTERM'].map((name) => {
    const handler = () => controller.abort(new Error(`Integration cancelled by ${name}`));
    process.on(name, handler);
    return [name, handler];
  });
  return {
    signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
    dispose: () => handlers.forEach(([name, handler]) => process.off(name, handler)),
  };
}

async function runCommand(command, args, options = {}, capture = (data) => process.stdout.write(data)) {
  const { signal, timeout, ...spawnOptions } = options;
  const deadline = AbortSignal.timeout(timeout);
  const cancellation = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  cancellation.throwIfAborted();
  const child = spawn(command, args, {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    ...spawnOptions,
  });
  const env = spawnOptions.env ?? process.env;
  const unregister =
    child.pid !== undefined && env.INTEGRATION_FIXTURE_ROOT !== undefined
      ? registerProcess(child.pid, env.INTEGRATION_FIXTURE_ROOT, env.INTEGRATION_PROCESS_REGISTRY)
      : () => {};
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = new Promise((resolve) => {
    child.once('error', resolve);
    child.once('exit', resolve);
  });
  let onAbort;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          code === 0 ? resolve() : reject(new Error(`Command failed (${signal ?? code})`)),
        );
      }),
      new Promise((_resolve, reject) => {
        onAbort = () => reject(cancellation.reason);
        cancellation.addEventListener('abort', onAbort, { once: true });
        if (cancellation.aborted) {
          onAbort();
        }
      }),
    ]);
  } finally {
    cancellation.removeEventListener('abort', onAbort);
    // Explicit tree termination must happen before Node discards the parent PID.
    // Passing spawn's timeout/signal would kill only that parent first.
    await stopProcess(child, exited);
    unregister();
  }
}

export async function runNativeTests({ files, env = process.env, signal, timeout = 480_000, capture } = {}) {
  const cancellation = cancellationSignals(signal);
  const root = await mkdtemp(join(env.INTEGRATION_FIXTURE_ROOT ?? tmpdir(), 'composer test runner '));
  const registry = env.INTEGRATION_PROCESS_REGISTRY ?? join(root, 'processes');
  await mkdir(registry, { recursive: true });
  const childEnv = { ...env, INTEGRATION_FIXTURE_ROOT: root, INTEGRATION_PROCESS_REGISTRY: registry };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    await runCommand(
      process.execPath,
      ['--experimental-strip-types', '--test', '--test-concurrency=1', '--test-timeout=300000', ...files],
      { env: childEnv, signal: cancellation.signal, timeout },
      capture,
    );
  } finally {
    try {
      await cleanupProcesses(registry, root);
    } finally {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } finally {
        cancellation.dispose();
      }
    }
  }
}

async function main() {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const artifacts = join(repository, 'integration-results');
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts);
  const root = await mkdtemp(join(tmpdir(), 'composer runner '));
  const cancellation = cancellationSignals();
  let transcript = '';
  const capture = (data) => {
    const text = data.toString();
    process.stdout.write(text);
    transcript = (transcript + text).slice(-65_536);
  };
  const run = (command, args, options = {}) =>
    runCommand(command, args, { ...options, signal: cancellation.signal }, capture);
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
    const ripgrep = ripgrepPackage();
    const archiveName = `ripgrep-${ripgrepVersion}-${ripgrep.target}.${ripgrep.extension}`;
    const archive = join(root, archiveName);
    await run(
      process.platform === 'win32' ? 'curl.exe' : 'curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--retry',
        '2',
        '--max-time',
        '60',
        `https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepVersion}/${archiveName}`,
        '--output',
        archive,
      ],
      { timeout: 120_000 },
    );
    assert.equal(
      createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
      ripgrep.sha256,
      'ripgrep archive checksum mismatch',
    );
    await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', root], { timeout: 30_000 });
    const ripgrepDirectory = join(root, `ripgrep-${ripgrepVersion}-${ripgrep.target}`);
    const verifiedRipgrep = await promisify(execFile)(join(ripgrepDirectory, ripgrep.executable), ['--version'], {
      timeout: 10_000,
      signal: cancellation.signal,
    });
    assert.equal(verifiedRipgrep.stdout.split(/\s+/)[1], ripgrepVersion, verifiedRipgrep.stdout);
    const testEnvironment = { ...process.env, OPENCODE_BIN: binary, INTEGRATION_ARTIFACT_DIR: artifacts };
    const pathKey = Object.keys(testEnvironment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    testEnvironment[pathKey] = `${ripgrepDirectory}${delimiter}${testEnvironment[pathKey] ?? ''}`;
    const { stdout } = await promisify(execFile)(binary, ['--version'], {
      env: isolatedEnvironment(root),
      timeout: 30_000,
      signal: cancellation.signal,
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
          ripgrep: ripgrepVersion,
          package: manifest.version,
        },
        null,
        2,
      ),
    );
    await runNativeTests({
      files: [
        'tests/config-composer.native.ts',
        'tests/integration/lifecycle.integration.ts',
        'tests/integration/cleanup.integration.mjs',
      ],
      env: { ...testEnvironment, INTEGRATION_FIXTURE_ROOT: root },
      signal: cancellation.signal,
      capture,
    });
  } finally {
    try {
      await writeFile(join(artifacts, 'runner.log'), Buffer.from(transcript).subarray(-65_536));
    } finally {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } finally {
        cancellation.dispose();
      }
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
