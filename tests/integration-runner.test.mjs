import assert from 'node:assert/strict';
import { test } from 'node:test';
import { integrationFiles, nativePackage, ripgrepPackage } from '../scripts/integration.mjs';
import { isolatedEnvironment } from './integration/harness.ts';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { stopProcess } from './integration/process.ts';

test('integration runner selects native Linux and Windows binaries and rejects untested platforms', () => {
  assert.deepEqual(nativePackage('linux', 'x64'), { name: 'opencode-linux-x64', executable: 'opencode' });
  assert.deepEqual(nativePackage('win32', 'x64'), { name: 'opencode-windows-x64', executable: 'opencode.exe' });
  assert.throws(() => nativePackage('darwin', 'x64'), /Linux and Windows/);
  assert.throws(() => nativePackage('linux', 'arm64'), /x64/);
});

test('CI suites partition every portable integration file exactly once', async () => {
  const expected = [
    'tests/config-composer.native.ts',
    'tests/composition-profiles.native.ts',
    ...(await readdir(new URL('./integration/', import.meta.url)))
      .filter((name) => /\.integration\.(?:ts|mjs)$/.test(name))
      .map((name) => `tests/integration/${name}`),
  ].sort();
  const files = [...integrationFiles('core'), ...integrationFiles('canonical'), ...integrationFiles('cleanup')];
  assert.equal(new Set(files).size, files.length, 'a portable case belongs to exactly one CI suite');
  assert.deepEqual(files.sort(), expected);
  assert.deepEqual(integrationFiles().sort(), expected);
  assert.throws(() => integrationFiles('missing'), /Unknown integration suite/);
});

test('native ripgrep prerequisites use pinned platform binaries and release checksums', () => {
  assert.equal(ripgrepPackage('win32').executable, 'rg.exe');
  assert.equal(ripgrepPackage('linux').executable, 'rg');
  assert.match(ripgrepPackage('win32').sha256, /^[a-f0-9]{64}$/);
  assert.match(ripgrepPackage('linux').sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => ripgrepPackage('darwin'), /Linux or Windows/);
});

test('native child environment excludes inherited credentials and personal configuration', () => {
  const keys = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_SERVER_PASSWORD',
    'BUN_OPTIONS',
    'NODE_OPTIONS',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      process.env[key] = 'must-not-leak';
    }
    const env = isolatedEnvironment('fixture-root');
    for (const key of keys) {
      assert.equal(env[key], undefined, key);
    }
    assert.equal(env.OPENCODE_DB, join('fixture-root', 'sessions.sqlite'));
    assert.equal(env.OPENCODE_TEST_HOME, 'fixture-root');
    assert.equal(env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER, 'true');
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = before[key];
      }
    }
  }
});

test(
  'native process shutdown reaps a parent whose descendant retains its output pipes',
  { timeout: 10_000 },
  async (t) => {
    const descendantCode = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)";
    const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`;
    const child = spawn(process.execPath, ['-e', parentCode], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const exited = once(child, 'exit');
    t.after(() => stopProcess(child, exited));
    const [output] = await once(child.stdout, 'data');
    const descendant = Number(output.toString().trim());
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    await stopProcess(child, exited);
    assert.equal(child.stdout.destroyed, true);
    if (process.platform === 'linux') {
      // An orphan can briefly remain as a zombie until init reaps it; it cannot hold a pipe.
      const status = await readFile(`/proc/${descendant}/stat`, 'utf8').catch(() => 'gone');
      assert.ok(status === 'gone' || /^\d+ \(.*\) Z /.test(status), status);
    }
  },
);
