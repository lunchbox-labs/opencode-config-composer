import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isolatedEnvironment } from '../harness.ts';
import { launchNativeHost } from '../native-host.ts';

test('native host remains active until the outer runner interrupts it', async (t) => {
  t.after(() => writeFile(`${process.env.INTEGRATION_READY_FILE!}.after`, 'test hook ran'));
  // This case exercises native process ownership, not Composer loading. Share the
  // functional harness's real launch/registration path without npm installation.
  const root = await mkdtemp(join(process.env.INTEGRATION_FIXTURE_ROOT ?? tmpdir(), 'composer interrupted native '));
  const project = join(root, 'project');
  await mkdir(project);
  const { child } = launchNativeHost(project, isolatedEnvironment(root), root);
  let output = '';
  let failure: Error | undefined;
  child.on('error', (error) => {
    failure = error;
  });
  const capture = (data: Buffer) => {
    output = (output + data.toString()).slice(-8192);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  let url: string | undefined;
  for (let attempt = 0; attempt < 400; attempt++) {
    if (failure !== undefined) {
      throw failure;
    }
    assert.equal(child.exitCode, null, output);
    url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
    if (url !== undefined) {
      break;
    }
    await setTimeout(100);
  }
  assert.ok(url !== undefined, output);
  const response = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.ok, true);
  await writeFile(
    process.env.INTEGRATION_READY_FILE!,
    JSON.stringify({ root, pid: child.pid, url: response.url, runner: process.ppid, worker: process.pid }),
  );
  await new Promise(() => {});
});
