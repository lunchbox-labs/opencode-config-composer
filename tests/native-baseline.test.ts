import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editNativeBaseline, verifyNativeAgents } from '../src/config-composer/composition/native-baseline.ts';

test('server and editor native agent comparison normalizes groups but rejects differing substitution inputs', () => {
  const local = { worker: { model: 'fixture/a', groups: ['work'], prompt: 'Native prompt' } };
  const server = { worker: { model: 'fixture/a', options: { groups: ['work'] }, prompt: 'Native prompt' } };
  verifyNativeAgents(local, server);
  for (const changed of [
    { ...server, extra: {} },
    { worker: { ...server.worker, model: 'fixture/b' } },
    { worker: { ...server.worker, prompt: 'Other prompt' } },
    { worker: { ...server.worker, options: { groups: [] } } },
  ]) {
    assert.throws(() => verifyNativeAgents(local, changed), /same environment.*reload/s);
  }
});

test('native source edits retain authoritative fields and replace normalized memberships', () => {
  const baseline = {
    worker: { model: 'fixture/a', options: { groups: ['work'], nativeOption: 9 }, permission: { edit: 'deny' } },
  };
  const before = { worker: { model: 'fixture/a', groups: ['work'] } };
  const after = { worker: { groups: ['review'] } };
  const edited = editNativeBaseline(baseline, before, after);
  assert.deepEqual(edited.worker, { groups: ['review'], options: { nativeOption: 9 }, permission: { edit: 'deny' } });
  assert.equal(baseline.worker.model, 'fixture/a');
});
