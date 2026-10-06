import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { runNativeTests } from '../../scripts/integration.mjs';
import { killProcessTree, processIsRunning } from './process.ts';

for (const interruption of ['timeout', 'SIGINT', 'SIGTERM']) {
  test(
    `outer ${interruption} stops the native host and removes its fixture without test hooks`,
    { timeout: 180_000 },
    async (t) => {
      const root = await mkdtemp(
        join(process.env.INTEGRATION_FIXTURE_ROOT ?? tmpdir(), 'composer cleanup regression '),
      );
      const ready = join(root, 'ready.json');
      const controller = new AbortController();
      let transcript = '';
      let fixture;
      const run = runNativeTests({
        files: ['tests/integration/fixtures/blocked-runner.mjs'],
        env: { ...process.env, INTEGRATION_READY_FILE: ready },
        signal: controller.signal,
        // Allow cold Windows startup before exercising the real outer numeric deadline.
        timeout: 90_000,
        capture: (data) => {
          transcript = (transcript + data.toString()).slice(-8192);
        },
      });
      // Observe rejection immediately, including early launch failures, to avoid an
      // unhandled rejection while polling the real host's readiness marker.
      const outcome = run.then(
        () => undefined,
        (error) => error,
      );
      t.after(async () => {
        controller.abort();
        await outcome;
        // Emergency cleanup keeps a regressing test from leaking its reproduction.
        // Assertions below execute before this fallback.
        if (fixture !== undefined && (await stat(fixture.root).catch(() => undefined))) {
          await killProcessTree(fixture.pid);
          await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
        if (fixture !== undefined && (await processIsRunning(fixture.runner))) {
          await killProcessTree(fixture.runner);
        }
        await rm(root, { recursive: true, force: true });
      });
      for (let attempt = 0; attempt < 800; attempt++) {
        const contents = await readFile(ready, 'utf8').catch(() => undefined);
        if (contents !== undefined && (await stat(`${ready}.blocked`).catch(() => undefined))) {
          fixture = JSON.parse(contents);
          break;
        }
        await setTimeout(100);
      }
      assert.ok(fixture, transcript);
      assert.equal((await fetch(fixture.url)).ok, true);
      assert.equal(await processIsRunning(fixture.pid), true);
      if (interruption !== 'timeout') {
        // Windows process.kill() terminates directly. Emitting the Node signal event
        // exercises the same registered cancellation handler on both platforms.
        if (process.platform === 'win32') {
          process.emit(interruption);
        } else {
          process.kill(process.pid, interruption);
        }
      }
      const error = await outcome;
      assert.ok(error instanceof Error, transcript);
      assert.match(error.message, interruption === 'timeout' ? /timeout/i : new RegExp(interruption));
      await assert.rejects(
        fetch(fixture.url, { signal: AbortSignal.timeout(1000) }),
        'native host survived outer interruption',
      );
      assert.equal(await processIsRunning(fixture.pid), false, 'native process survived outer interruption');
      assert.equal(await processIsRunning(fixture.runner), false, 'nested runner survived outer interruption');
      assert.equal(await processIsRunning(fixture.worker), false, 'nested test worker survived outer interruption');
      await assert.rejects(stat(fixture.root), { code: 'ENOENT' });
      await assert.rejects(stat(`${ready}.after`), { code: 'ENOENT' }, 'test hooks unexpectedly supplied cleanup');
    },
  );
}
