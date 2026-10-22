import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';
test(
  'inspector attests configured fields without bodies and retains session history across profile changes',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'running-inspector');
    await f.write(f.paths.shared, { profiles: { a: { agent: { worker: { model: 'fixture/beta' } } } } });
    await f.host.start();
    const sent = await f.send();
    await f.editor.reload(await f.editor.select('a'));
    const runtime = await f.editor.runtime();
    assert.equal(runtime.candidate?.decisions['/agent/worker/model'].value, 'fixture/beta');
    assert.doesNotMatch(JSON.stringify(runtime), /NATIVE_WORKER|NATIVE_REVIEW/);
    const history = await f.host.api<unknown[]>(`/session/${sent.session.id}/message`);
    assert.ok(history.length >= 2);
    assert.ok(JSON.stringify(history).includes('alpha'));
    assert.equal((await f.editor.context()).selection.choice, 'a');
  },
);
