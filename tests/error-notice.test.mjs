import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

// OpenCode shares the client Solid runtime with TUI plugins. Plain Node otherwise
// selects Solid's server build, which deliberately does not track store updates.
test('error notices follow the host reactive config and plugin lifecycle', async () => {
  await promisify(execFile)(process.execPath, [
    '--conditions=browser',
    '--experimental-strip-types',
    '--test',
    'tests/error-notice.reactive.ts',
  ]);
});
