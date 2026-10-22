import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import server from '../../src/server.ts';
import { selectionStateDirectory } from '../../src/config-composer/composition/selection-state.ts';

test('server startup publishes a real selection proof', async () => {
  await server.server({});
  const directory = selectionStateDirectory();
  assert.equal((await readdir(join(directory, 'config-composer/v2/processes'))).length, 1);
  console.log(`STATE_DIRECTORY=${JSON.stringify(process.env.XDG_STATE_HOME)}`);
  if (process.env.COMPOSER_FAIL_FIXTURE === '1') {
    assert.fail('intentional fixture failure');
  }
});
