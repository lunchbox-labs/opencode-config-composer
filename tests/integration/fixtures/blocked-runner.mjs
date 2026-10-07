import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { runNativeTests } from '../../../scripts/integration.mjs';

const running = runNativeTests({ files: ['tests/integration/fixtures/hanging-native.ts'] });
const ready = process.env.INTEGRATION_READY_FILE;
while ((await readFile(ready).catch(() => undefined)) === undefined) {
  await setTimeout(100);
}
await writeFile(`${ready}.blocked`, 'ready');
// A stuck test worker cannot execute its signal handlers or after hooks. The
// enclosing runner must own cleanup of the detached runner and native host.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
await running;
