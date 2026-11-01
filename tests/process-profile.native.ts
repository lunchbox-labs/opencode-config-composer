import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';

const variable = 'OPENCODE_CONFIG_COMPOSER_PROFILE';
type Fixture = Awaited<ReturnType<typeof compositionFixture>>;
// Native run also asks the small model for a session title; the worker request carries its prompt.
function workerRequest(f: Fixture, text: string) {
  const request = f.host.requests.find((body) => {
    const messages = JSON.stringify(body.messages);
    return messages.includes(text) && messages.includes('NATIVE_WORKER');
  });
  assert.ok(request !== undefined, `worker request for ${text}`);
  return request;
}

test(
  'process profiles override the saved choice for simultaneous servers and opencode run without changing it',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'process-profile');
    await f.write(f.paths.shared, {
      profiles: {
        a: { agent: { worker: { model: 'fixture/beta' } } },
        b: { agent: { worker: { options: { phase: 'b' } } } },
      },
      defaultProfile: 'b',
    });
    await f.host.start();
    const saved = await f.editor.select(null);
    const savedBytes = await readFile(saved.selection.path);
    await f.host.stop();

    await f.host.start({ variables: { [variable]: 'a' } });
    const runtime = await f.editor.runtime();
    assert.equal(runtime.processProfile, 'a');
    assert.equal(runtime.candidate?.profile, 'a');
    await assert.rejects(f.editor.context(), /OPENCODE_CONFIG_COMPOSER_PROFILE selects profile a.*read-only/);
    // While this server runs, two more processes share the worktree: one names
    // another profile and one follows the saved Shared only choice.
    const [named, unset] = await Promise.all([
      f.host.run(['--agent', 'worker', 'Run with profile b.'], { [variable]: 'b' }),
      f.host.run(['--agent', 'worker', 'Run with the saved choice.']),
    ]);
    assert.equal(named.code, 0, named.stderr);
    assert.equal(unset.code, 0, unset.stderr);
    const b = workerRequest(f, 'Run with profile b.');
    assert.equal(b.model, 'alpha');
    assert.equal(b.phase, 'b');
    const shared = workerRequest(f, 'Run with the saved choice.');
    assert.equal(shared.model, 'alpha');
    assert.equal(shared.phase, undefined);
    assert.equal((await f.editor.runtime()).id, runtime.id);
    assert.equal((await f.send()).captured.model, 'beta');
    assert.deepEqual(await readFile(saved.selection.path), savedBytes);
  },
);

test(
  'an unknown process profile stops composition with a diagnostic instead of falling back',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'process-profile-unknown');
    await f.write(f.paths.shared, {
      profiles: { a: { agent: { worker: { model: 'fixture/beta' } } } },
      defaultProfile: 'a',
    });
    const result = await f.host.run(['--print-logs', '--agent', 'worker', 'Run with a missing profile.'], {
      [variable]: 'missing',
    });
    assert.match(result.stderr, /OPENCODE_CONFIG_COMPOSER_PROFILE names unknown profile \\?"missing\\?"/);
    // Neither the default profile nor a saved choice replaces the requested profile.
    assert.equal(workerRequest(f, 'Run with a missing profile.').model, 'alpha');
  },
);
