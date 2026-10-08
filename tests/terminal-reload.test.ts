import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRuntimeBaseline } from '../src/config-composer/composition/runtime-baseline.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { reloadFromTerminal } from './integration/terminal-editor.ts';

type Fixture = Parameters<typeof reloadFromTerminal>[0];
type Terminal = Parameters<typeof reloadFromTerminal>[1];
type Runtime = Awaited<ReturnType<Fixture['editor']['runtime']>>;
const previous = { baseline: { model: 'fixture/base' }, applied: { id: 'old' } } as Runtime;
const current = { ...previous, applied: { ...previous.applied, id: 'new' } };

function missingBaseline(): never {
  readRuntimeBaseline({ plugin: [packageName] }, { root: '/fixture', directory: '/fixture' });
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
  const terminal = { choose: async () => {}, press: async () => {} } as unknown as Terminal;
  return { run: () => reloadFromTerminal(fixture, terminal), reads: () => reads, agentReads: () => agentReads };
}

test('terminal reload waits through unpublished registration and an old marker before accepting the new baseline', async () => {
  const f = fixture([() => previous, missingBaseline, () => previous, () => current]);
  await f.run();
  assert.equal(f.reads(), 4);
  assert.equal(f.agentReads(), 1);
});

test('terminal reload propagates host and configuration errors without retrying', async () => {
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

test('terminal reload still rejects a changed native baseline after registration', async () => {
  const f = fixture([() => previous, () => ({ ...current, baseline: { model: 'fixture/changed' } })]);
  await assert.rejects(f.run(), /scoped apply retains the native baseline/);
});

test(
  'terminal reload retains the missing-marker error when bounded readiness expires',
  { timeout: 20_000 },
  async () => {
    const f = fixture([() => previous, missingBaseline]);
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /did not publish a new native registration/);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /runtime baseline version is missing or ambiguous/);
      return true;
    });
    assert.equal(f.reads(), 201);
    assert.equal(f.agentReads(), 0);
  },
);
