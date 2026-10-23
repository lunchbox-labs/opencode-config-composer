import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';

test(
  'native empty variant resets inherited high to the same request default as omission',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'native-variant-reset');
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        worker: { ...f.native.agent.worker, model: 'fixture/beta', variant: 'high' },
        helper: { ...f.native.agent.helper, model: 'fixture/beta' },
        high: { mode: 'primary', model: 'fixture/beta', variant: 'high' },
      },
    });

    await f.write(f.paths.shared, { agent: { worker: { variant: '' } } });
    await f.host.start();
    const config = await f.host.api<{ agent: Record<string, Record<string, unknown>> }>('/config');
    assert.equal(config.agent.worker.variant, '');
    const agents = await f.host.api<{ name: string; variant?: string }[]>('/agent');
    assert.equal(agents.find((agent) => agent.name === 'worker')?.variant, '');
    const reset = await f.send('worker');
    const omitted = await f.send('helper');
    const high = await f.send('high');
    assert.equal(reset.captured.reasoning_effort, omitted.captured.reasoning_effort);
    assert.equal(reset.captured.reasoning_effort, undefined);
    assert.equal(high.captured.reasoning_effort, 'high');
  },
);

test(
  'installed alias bindings survive A B A Shared only with atomic variants, named exceptions and final pins',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'native-model-aliases');
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        worker: { ...f.native.agent.worker, groups: ['coding'], model: 'fixture/alpha', variant: 'high' },
        helper: { ...f.native.agent.helper, groups: ['coding'] },
      },
    });
    await mkdir(join(f.host.configRoot, 'agents'));
    const body = '---\ngroups: [coding]\nmodel: fixture/alpha\nvariant: high\n---\nNATIVE_PINNED_BODY';
    await writeFile(join(f.host.configRoot, 'agents/pinned.md'), body);
    await f.write(f.paths.shared, {
      models: { coding: { model: 'fixture/alpha' }, support: { model: 'fixture/alpha' } },
      groups: { coding: { agent: { modelRef: 'coding', temperature: 0 } } },
      agent: { helper: { modelRef: 'support', variant: 'high' } },
      profiles: {
        a: { models: { coding: { model: 'fixture/beta', variant: 'high' } } },
        b: { models: { coding: { model: 'fixture/beta' } } },
      },
    });
    const nativeBytes = await readFile(f.paths.native);
    await f.host.start();
    await f.editor.runtime();
    // Definitions remain the startup capture even when the external file changes.
    await f.write(f.paths.shared, { invalidAfterStartup: true });
    for (const [choice, model, variant, effort] of [
      ['a', 'beta', 'high', 'high'],
      ['b', 'beta', '', undefined],
      ['a', 'beta', 'high', 'high'],
      [null, 'alpha', '', undefined],
    ] as const) {
      await f.editor.applySelection(await f.editor.select(choice));
      const config = await f.host.api<{ agent: Record<string, Record<string, unknown>>; models?: unknown }>('/config');
      assert.equal(config.agent.worker.model, `fixture/${model}`);
      assert.equal(config.agent.worker.variant, variant);
      assert.equal(config.agent.worker.temperature, 0);
      assert.equal(config.agent.helper.model, 'fixture/alpha');
      assert.equal(config.agent.helper.variant, 'high');
      assert.equal(config.agent.pinned.model, 'fixture/alpha');
      assert.equal(config.agent.pinned.variant, 'high');
      assert.equal(config.models, undefined);
      const agents =
        await f.host.api<
          { name: string; model?: { modelID: string }; variant?: string; options: Record<string, unknown> }[]
        >('/agent');
      const worker = agents.find((agent) => agent.name === 'worker');
      assert.equal(worker?.model?.modelID, model);
      assert.equal(worker.variant, variant);
      for (const name of ['worker', 'helper', 'pinned']) {
        assert.equal(config.agent[name].modelRef, undefined);
        assert.equal((config.agent[name].options as Record<string, unknown>).modelRef, undefined);
        assert.equal(agents.find((agent) => agent.name === name)?.options.modelRef, undefined);
      }
      const runtime = await f.editor.runtime();
      assert.equal(
        runtime.candidate!.decisions['/agent/worker/model'].origin.modelBinding?.pointer,
        choice === null ? '/models/coding' : `/profiles/${choice}/models/coding`,
      );
      assert.equal(runtime.candidate!.decisions['/agent/pinned/model'].origin.kind, 'frontmatter');
      assert.equal(runtime.candidate!.decisions['/agent/pinned/model'].blockedComposer?.value, `fixture/${model}`);
      const sent = await f.send('worker');
      assert.equal(sent.captured.model, model);
      assert.equal(sent.captured.reasoning_effort, effort);
      assert.doesNotMatch(JSON.stringify(sent.captured), /modelRef|modelBinding/);
    }
    assert.equal(await readFile(join(f.host.configRoot, 'agents/pinned.md'), 'utf8'), body);
    assert.deepEqual(await readFile(f.paths.native), nativeBytes);
  },
);

test(
  'installed profile-only reference leaves Shared only native model and variant intact and rejects an unbound profile',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'native-profile-only-alias');
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        ...f.native.agent,
        worker: { ...f.native.agent.worker, groups: ['coding'], model: 'fixture/alpha', variant: 'high' },
      },
    });
    await f.write(f.paths.shared, {
      groups: { coding: { agent: { modelRef: 'coding', variant: '', temperature: 0 } } },
      profiles: { a: { models: { coding: { model: 'fixture/beta', variant: 'high' } } }, unbound: {} },
    });
    await f.host.start();
    const config = await f.host.api<{ agent: Record<string, Record<string, unknown>> }>('/config');
    assert.equal(config.agent.worker.model, 'fixture/alpha');
    assert.equal(config.agent.worker.variant, 'high');
    assert.equal(config.agent.worker.temperature, 0);
    await f.editor.applySelection(await f.editor.select('a'));
    const active = await f.host.api<{ agent: Record<string, Record<string, unknown>> }>('/config');
    assert.equal(active.agent.worker.model, 'fixture/beta');
    assert.equal(active.agent.worker.variant, '');
    await assert.rejects(f.editor.select('unbound'), /\/groups\/coding\/agent\/modelRef.*coding.*profile.*unbound/i);
    assert.equal((await f.editor.runtime()).candidate!.profile, 'a');
  },
);
