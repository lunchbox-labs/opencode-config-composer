import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSnapshot } from '../src/config-composer/storage.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { compositionRevision, observeNativeFiles } from '../src/config-composer/composition/revision.ts';
import { type ApplyPort, applySavedComposition } from '../src/config-composer/composition/apply.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-scoped-apply-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode'));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName], model: 'fixture/native' }));
  const source = join(root, 'config-composer.jsonc');
  await writeFile(source, JSON.stringify({ defaults: { model: 'fixture/changed' } }));
  const snapshot = await loadSnapshot(root);
  const revision = compositionRevision(snapshot.sources, snapshot.resolved, snapshot.files);
  const observedNativeFiles = await observeNativeFiles(root);
  const previous = { id: 'before', observedNativeFiles };
  const calls: string[] = [];
  const port: ApplyPort = {
    assertCurrent: () => {},
    activity: async () => {
      calls.push('activity');
      return {};
    },
    dispose: async () => {
      calls.push('dispose');
    },
    refresh: async () => {
      calls.push('refresh');
      return { id: 'after', revision, observedNativeFiles };
    },
  };
  return { root, source, snapshot, revision, previous, calls, port };
}

test('scoped apply checks activity immediately before disposal and attests the refreshed revision without writing native files', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, 'opencode.jsonc'), 'utf8');
  assert.deepEqual(await applySavedComposition(f.snapshot, f.previous, f.port), f.revision);
  assert.deepEqual(f.calls, ['activity', 'dispose', 'refresh']);
  assert.equal(await readFile(join(f.root, 'opencode.jsonc'), 'utf8'), before);
});

test('busy sessions retain saved inputs and allow an explicit retry', async (t) => {
  const f = await fixture(t);
  const idle = f.port.activity;
  f.port.activity = async () => ({ child: { type: 'retry' } });
  await assert.rejects(applySavedComposition(f.snapshot, f.previous, f.port), /still running.*saved/i);
  assert.deepEqual(f.calls, []);
  assert.match(await readFile(f.source, 'utf8'), /fixture\/changed/);
  f.port.activity = idle;
  await applySavedComposition(f.snapshot, f.previous, f.port);
  assert.deepEqual(f.calls, ['activity', 'dispose', 'refresh']);
});

test('a failed disposal or refresh cannot report the saved revision as applied', async (t) => {
  const f = await fixture(t);
  f.port.dispose = async () => {
    throw new Error('offline');
  };
  await assert.rejects(applySavedComposition(f.snapshot, f.previous, f.port), /offline/);
  assert.deepEqual(f.calls, ['activity']);
  f.port.dispose = async () => {};
  f.port.refresh = async () => ({ ...f.previous });
  await assert.rejects(applySavedComposition(f.snapshot, f.previous, f.port), /applied revision|rebootstrap/i);
  f.port.refresh = async () => ({ ...f.previous, id: 'new', revision: { ...f.revision, effective: '0'.repeat(64) } });
  await assert.rejects(applySavedComposition(f.snapshot, f.previous, f.port), /applied revision/i);
});

test('changed native JSON inputs require restart without disposing any instance', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName], model: 'fixture/new' }));
  const latest = await loadSnapshot(f.root);
  await assert.rejects(applySavedComposition(latest, f.previous, f.port), /native.*restart/i);
  assert.deepEqual(f.calls, []);
});

test('source changes before or during apply preserve saved bytes and prevent success', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.source, 'utf8');
  await writeFile(f.source, before + '\n// Concurrent save');
  await assert.rejects(applySavedComposition(f.snapshot, f.previous, f.port), /changed/i);
  assert.deepEqual(f.calls, []);
  const latest = await loadSnapshot(f.root);
  f.port.dispose = async () => {
    await writeFile(f.source, before + '\n// Saved during disposal');
  };
  await assert.rejects(applySavedComposition(latest, f.previous, f.port), /changed/i);
  assert.match(await readFile(f.source, 'utf8'), /Saved during disposal/);
});

test('connection changes at the final activity boundary prevent disposal', async (t) => {
  const f = await fixture(t);
  let current = true;
  f.port.activity = async () => {
    current = false;
    return {};
  };
  f.port.assertCurrent = () => {
    if (!current) {
      throw new Error('connection changed');
    }
  };
  await assert.rejects(applySavedComposition(f.snapshot, f.previous, f.port), /connection changed/);
  assert.deepEqual(f.calls, []);
});

test('a saved-source edit during the activity request prevents disposal and refresh', async (t) => {
  const f = await fixture(t);
  f.port.activity = async () => {
    await writeFile(f.source, JSON.stringify({ defaults: { model: 'fixture/unreviewed' } }));
    return {};
  };
  await assert.rejects(applySavedComposition(f.snapshot, f.previous, f.port), /changed/i);
  assert.deepEqual(f.calls, [], 'unreviewed input must never trigger rebootstrap');
  assert.match(await readFile(f.source, 'utf8'), /fixture\/unreviewed/);
});

test('connection changes during final input verification prevent success after disposal', async (t) => {
  const f = await fixture(t);
  let current = true;
  const refresh = f.port.refresh.bind(f.port);
  f.port.refresh = async () => {
    const result = await refresh();
    setImmediate(() => {
      current = false;
    });
    return result;
  };
  f.port.assertCurrent = () => {
    if (!current) {
      throw new Error('connection changed during verification');
    }
  };
  await assert.rejects(applySavedComposition(f.snapshot, f.previous, f.port), /connection changed/);
  assert.deepEqual(f.calls, ['activity', 'dispose', 'refresh']);
});
