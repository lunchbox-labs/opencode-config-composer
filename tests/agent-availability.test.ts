import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';
import { resolveProfileRuntime } from '../src/config-composer/composition/runtime.ts';
import { readCompositionDocument } from '../src/config-composer/composition/document.ts';
import type { NativeInput } from '../src/config-composer/composition/types.ts';

async function fixture(t: TestContext, document: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'composer-availability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode'));
  const file = join(root, 'config-composer.jsonc');
  await writeFile(file, JSON.stringify(document));
  return {
    file,
    resolve: async (native: NativeInput = {}) =>
      resolveProfileRuntime(await loadCompositionSources({ root, baseFile: file, baseExplicit: true }), native),
  };
}

test('availability accepts only named booleans and rejects missing and internal targets with declaring pointers', async (t) => {
  assert.deepEqual(
    readCompositionDocument({ profiles: { work: { agentAvailability: { build: false } } } }).profiles?.work
      .agentAvailability,
    { build: false },
  );
  assert.throws(
    () => readCompositionDocument({ profiles: { work: { agentAvailability: { build: 'disable' } } } }),
    /agentAvailability/,
  );
  for (const name of ['missing', 'title', 'summary', 'compaction']) {
    const f = await fixture(t, { profiles: { work: { agentAvailability: { [name]: false } } } });
    await assert.rejects(
      f.resolve(),
      (error: unknown) => error instanceof Error && error.message.includes(`/profiles/work/agentAvailability/${name}`),
    );
  }
});

test('ordered availability preserves disabled group definitions and restores later native enablement', async (t) => {
  const f = await fixture(t, {
    componentGroups: { work: { agents: ['build', 'dormant'], configuration: { model: 'fixture/group' } } },
    profiles: {
      base: { layers: [{ componentGroup: 'work' }], agentAvailability: { build: false, dormant: true } },
      again: { extends: 'base', agentAvailability: { build: true } },
    },
    activeProfiles: ['again', 'base'],
  });
  const native = {
    agent: {
      build: { prompt: 'Native build' },
      dormant: { disable: true, prompt: 'Native dormant', model: 'fixture/pin' },
    },
  };
  const result = await f.resolve(native);
  assert.equal(result.agent.build.disable, true);
  assert.equal(result.agent.build.prompt, 'Native build');
  assert.equal(result.agent.build.model, 'fixture/group');
  assert.equal(result.agent.dormant.disable, false);
  assert.equal(result.agent.dormant.model, 'fixture/pin');
  assert.equal(native.agent.dormant.disable, true);
  assert.equal(result.provenance['/agent/build/disable'].layer, 'profile:base');
  assert.ok(result.provenance['/agent/build/disable'].overwritten.length > 0);
});

test('explicit enable selects dormant components at its own profile before layers, never before an earlier profile', async (t) => {
  const document = {
    components: { agents: { custom: { prompt: 'Retained body', disable: true } } },
    configurationPresets: { fast: { model: 'fixture/fast' } },
    profiles: {
      preset: { layers: [{ configurationPreset: 'fast', target: { agents: ['custom'] } }] },
      enabled: { agentAvailability: { custom: true } },
    },
    activeProfiles: ['preset', 'enabled'],
  };
  const f = await fixture(t, document);
  await assert.rejects(f.resolve(), /must be selected before/);
  await writeFile(f.file, JSON.stringify({ ...document, activeProfiles: ['enabled', 'preset'] }));
  const result = await f.resolve();
  assert.equal(result.agent.custom.prompt, 'Retained body');
  assert.equal(result.agent.custom.disable, false);
  assert.equal(result.agent.custom.model, 'fixture/fast');
});

test('availability requires a visible primary and preserves a valid native default', async (t) => {
  const f = await fixture(t, {
    profiles: { work: { agentAvailability: { build: false, plan: false } } },
    activeProfiles: ['work'],
  });
  await assert.rejects(f.resolve(), /visible primary/);
  await assert.rejects(f.resolve({ agent: { hidden: { hidden: true } } }), /visible primary/);
  await assert.rejects(f.resolve({ agent: { child: { mode: 'subagent' } } }), /visible primary/);
  const result = await f.resolve({ default_agent: 'custom', agent: { custom: { mode: 'all' } } });
  assert.equal(result.default_agent, 'custom');
  await assert.rejects(f.resolve({ default_agent: 'build', agent: { custom: {} } }), /default_agent.*build/);
  await assert.rejects(
    f.resolve({ default_agent: 'hidden', agent: { custom: {}, hidden: { hidden: true } } }),
    /default_agent.*hidden/,
  );
});

test('hidden enabled agents stay hidden and selected commands cannot route to disabled agents', async (t) => {
  const f = await fixture(t, { profiles: { work: { agentAvailability: { hidden: true } } }, activeProfiles: ['work'] });
  const result = await f.resolve({ agent: { hidden: { disable: true, hidden: true } } });
  assert.equal(result.agent.hidden.hidden, true);
  assert.equal(result.agentAvailability.hidden.enabled, true);
  assert.equal(result.agentAvailability.hidden.hidden, true);
  await writeFile(
    f.file,
    JSON.stringify({
      components: { commands: { plan: { template: 'Plan', agent: 'plan' } } },
      componentGroups: { work: { commands: ['plan'] } },
      profiles: { work: { agentAvailability: { plan: false }, layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  await assert.rejects(f.resolve(), /Command plan names unavailable/);
});

test('removing the last availability decision cannot leave an unavailable native default', async (t) => {
  const document = {
    components: { agents: { custom: { prompt: 'Custom default' } } },
    profiles: { work: { agentAvailability: { custom: true } } },
    activeProfiles: ['work'],
  };
  const f = await fixture(t, document);
  assert.equal((await f.resolve({ default_agent: 'custom' })).agentAvailability.custom.enabled, true);
  await writeFile(f.file, JSON.stringify({ ...document, profiles: { work: {} } }));
  await assert.rejects(f.resolve({ default_agent: 'custom' }), /default_agent custom/);
});

test('prototype-like agent names preserve their own availability metadata', async (t) => {
  const f = await fixture(t, {
    components: { agents: { valueOf: { prompt: 'Dormant', mode: 'subagent' } } },
  });
  const result = await f.resolve({ agent: { toString: { prompt: 'Native' } } });
  const states = new Map(Object.entries(result.agentAvailability));
  assert.equal(states.get('toString')?.mode, 'all');
  assert.equal(states.get('toString')?.enabled, true);
  assert.equal(states.get('valueOf')?.mode, 'subagent');
  assert.equal(states.get('valueOf')?.status, 'unselected');
  await writeFile(
    f.file,
    JSON.stringify({
      components: { agents: { toString: { prompt: 'Retained', mode: 'subagent' } } },
      profiles: { work: { agentAvailability: { toString: false } } },
      activeProfiles: ['work'],
    }),
  );
  assert.deepEqual(Object.entries((await f.resolve()).agent).find(([name]) => name === 'toString')?.[1], {
    prompt: 'Retained',
    mode: 'subagent',
    options: {},
    disable: true,
  });
});
