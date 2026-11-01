import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readRuntimeContext } from '../src/config-composer/composition/runtime-baseline.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { applyFromTerminal } from './integration/terminal-editor.ts';

type Fixture = Parameters<typeof applyFromTerminal>[0];
type Terminal = Parameters<typeof applyFromTerminal>[1];
type Runtime = Awaited<ReturnType<Fixture['editor']['runtime']>>;
const previous = { native: { model: 'fixture/base' }, id: 'old' } as Runtime;
const current = { ...previous, id: 'new' };

function missingBaseline(): never {
  readRuntimeContext({ plugin: [packageName] }, { root: '/fixture', directory: '/fixture' });
  assert.fail('An unpublished registration must fail strict baseline reading');
}

function fixture(samples: (() => Runtime)[]) {
  let reads = 0;
  let agentReads = 0;
  const fixture = {
    host: {
      prepareConfigurationDependencies: async () => {},
      api: async () => {
        agentReads++;
      },
    },
    editor: { runtime: async () => samples[Math.min(reads++, samples.length - 1)]() },
  } as unknown as Fixture;
  const terminal = { text: () => '', choose: async () => {}, press: async () => {} } as unknown as Terminal;
  return {
    run: () => applyFromTerminal(fixture, terminal, 'Profile a applied.'),
    reads: () => reads,
    agentReads: () => agentReads,
  };
}

test('terminal profile apply waits through unpublished registration and an old marker before accepting the new baseline', async () => {
  const f = fixture([() => previous, missingBaseline, () => previous, () => current]);
  await f.run();
  assert.equal(f.reads(), 4);
  assert.equal(f.agentReads(), 1);
});

test('terminal profile apply propagates host and configuration errors without retrying', async () => {
  for (const failure of [
    new Error('HTTP 500'),
    new Error('Global models changed after Composer applied its configuration.'),
  ]) {
    const f = fixture([
      () => previous,
      () => {
        throw failure;
      },
      () => current,
    ]);
    await assert.rejects(f.run(), (error) => error === failure);
    assert.equal(f.reads(), 2);
    assert.equal(f.agentReads(), 0);
  }
});

test('terminal profile apply still rejects a changed native baseline after registration', async () => {
  const f = fixture([() => previous, () => ({ ...current, native: { model: 'fixture/changed' } })]);
  await assert.rejects(f.run(), /scoped apply retains the native baseline/);
});

test(
  'terminal profile apply retains the missing-marker error when bounded readiness expires',
  { timeout: 20_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture([() => previous, missingBaseline]);
    let settled = false;
    const outcome = assert
      .rejects(f.run(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /did not publish a new native registration/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /No runtime marker/);
        return true;
      })
      .finally(() => {
        settled = true;
      });
    // Flush promise continuations before each tick so the next real 50ms
    // readiness wait is registered. setImmediate is deliberately not mocked.
    for (let wait = 0; wait < 200; wait++) {
      await setImmediate();
      assert.equal(settled, false, 'readiness must not expire before its final wait');
      assert.equal(f.reads(), wait + 2);
      t.mock.timers.tick(49);
      await setImmediate();
      assert.equal(f.reads(), wait + 2, 'readiness waits the full 50ms between samples');
      assert.equal(settled, false);
      t.mock.timers.tick(1);
    }
    await outcome;
    assert.equal(f.reads(), 201);
    assert.equal(f.agentReads(), 0);
  },
);
