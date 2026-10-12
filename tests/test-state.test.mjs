import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

for (const failure of [false, true]) {
  test(`server test state is isolated and removed after ${failure ? 'failure' : 'success'}`, async (t) => {
    const inherited = await mkdtemp(join(tmpdir(), 'composer-user-state-'));
    t.after(() => rm(inherited, { recursive: true, force: true }));
    const env = { ...process.env, XDG_STATE_HOME: inherited, COMPOSER_FAIL_FIXTURE: failure ? '1' : '0' };
    delete env.NODE_TEST_CONTEXT;
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        './tests/isolated-state.mjs',
        '--test',
        'tests/fixtures/state-isolation.mjs',
      ],
      {
        cwd: new URL('../', import.meta.url),
        env,
      },
    ).catch((error) => error);
    assert.equal(result.code ?? 0, failure ? 1 : 0, result.stderr);
    const match = /STATE_DIRECTORY=(".*")/.exec(result.stdout);
    assert.ok(match, result.stdout);
    const isolated = JSON.parse(match[1]);
    assert.notEqual(isolated, inherited, 'test startup must not publish proofs into inherited personal state');
    assert.deepEqual(await readdir(inherited), [], 'personal state remains untouched');
    await assert.rejects(stat(isolated), { code: 'ENOENT' }, 'temporary state must be removed');
  });
}
