import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { nativeHarness } from '../harness.ts';

test('native host remains active until the outer runner interrupts it', async (t) => {
  t.after(() => writeFile(`${process.env.INTEGRATION_READY_FILE!}.after`, 'test hook ran'));
  const host = await nativeHarness(t, 'interrupted');
  await host.start();
  const response = await host.response('/global/health');
  await writeFile(
    process.env.INTEGRATION_READY_FILE!,
    JSON.stringify({ root: host.root, pid: host.pid, url: response.url, runner: process.ppid, worker: process.pid }),
  );
  await new Promise(() => {});
});
