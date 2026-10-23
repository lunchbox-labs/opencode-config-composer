import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';

type Fixture = Awaited<ReturnType<typeof compositionFixture>>;

async function parameterFixture(t: TestContext, name: string): Promise<Fixture> {
  const f = await compositionFixture(t, name);
  // Native suppresses agent temperature when the model does not declare support.
  for (const model of Object.values(f.native.provider.fixture.models)) {
    Object.assign(model, { temperature: true });
  }
  return f;
}

async function request(
  f: Fixture,
  agent: string,
  selection: { sessionID?: string; model?: { providerID: string; modelID: string }; variant?: string } = {},
) {
  const sessionID =
    selection.sessionID ?? (await f.host.api<{ id: string }>('/session', { title: 'Parameter dispatch' })).id;
  const before = f.host.requests.length;
  const message = await f.host.api<{ info: { error?: unknown; providerID: string; modelID: string } }>(
    `/session/${sessionID}/message`,
    {
      agent,
      ...(selection.model === undefined ? {} : { model: selection.model }),
      ...(selection.variant === undefined ? {} : { variant: selection.variant }),
      parts: [{ type: 'text', text: 'Reply briefly.' }],
    },
  );
  assert.equal(message.info.error, undefined);
  const captured = f.host.requests.slice(before).find((value) => value.model === message.info.modelID);
  assert.ok(captured !== undefined, 'the completed assistant request reached the synthetic provider');
  return { sessionID, info: message.info, captured };
}

test(
  'installed model parameters reach the wire and replace the whole same-model bundle across profiles',
  { timeout: 240000 },
  async (t) => {
    const f = await parameterFixture(t, 'native-model-parameters-profiles');
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        ...f.native.agent,
        worker: { ...f.native.agent.worker, groups: ['coding'] },
        helper: { ...f.native.agent.helper, model: 'fixture/beta' },
      },
    });
    await f.write(f.paths.shared, {
      models: {
        coding: {
          model: 'fixture/beta',
          temperature: 0.2,
          top_p: 0.8,
          maxOutputTokens: 128,
          options: { phase: 'shared', falseFlag: false, reasoningEffort: 'low' },
        },
      },
      groups: { coding: { agent: { modelRef: 'coding' } } },
      profiles: {
        a: {
          models: {
            coding: {
              model: 'fixture/beta',
              temperature: 0.4,
              top_p: 0.7,
              maxOutputTokens: 96,
              options: { phase: 'a', aOnly: true, reasoningEffort: 'medium' },
            },
          },
        },
        b: { models: { coding: { model: 'fixture/beta', top_p: 0.3 } } },
      },
    });
    const nativeBytes = await readFile(f.paths.native);
    await f.host.start();
    const baseline = (await request(f, 'helper')).captured;
    for (const [choice, temperature, topP, maxTokens, phase, effort] of [
      [null, 0.2, 0.8, 128, 'shared', 'low'],
      ['a', 0.4, 0.7, 96, 'a', 'medium'],
      ['b', baseline.temperature, 0.3, baseline.max_tokens, undefined, undefined],
      ['a', 0.4, 0.7, 96, 'a', 'medium'],
      [null, 0.2, 0.8, 128, 'shared', 'low'],
    ] as const) {
      await f.editor.applySelection(await f.editor.select(choice));
      const sent = await request(f, 'worker');
      assert.equal(sent.captured.model, 'beta');
      assert.equal(sent.captured.temperature, temperature);
      assert.equal(sent.captured.top_p, topP);
      assert.equal(sent.captured.max_tokens, maxTokens);
      assert.equal(sent.captured.phase, phase);
      assert.equal(sent.captured.reasoning_effort, effort);
      assert.equal(sent.captured.aOnly, choice === 'a' ? true : undefined);
      assert.equal(sent.captured.falseFlag, choice === null ? false : undefined);
      const config = await f.host.api<{ agent: Record<string, Record<string, unknown>> }>('/config');
      assert.equal(config.agent.worker.temperature, undefined, 'model-bound defaults stay out of native agent fields');
      assert.equal(config.agent.worker.top_p, undefined);
      assert.equal((config.agent.worker.options as Record<string, unknown>).phase, undefined);
    }
    assert.deepEqual(await readFile(f.paths.native), nativeBytes);
  },
);

test(
  'installed parameter dispatch matches both provider and model for caller and retained session selections',
  { timeout: 240000 },
  async (t) => {
    const f = await parameterFixture(t, 'native-model-parameters-dispatch');
    await f.write(f.paths.native, {
      ...f.native,
      enabled_providers: ['fixture', 'other'],
      provider: { ...f.native.provider, other: { ...f.native.provider.fixture, name: 'Other fixture' } },
      agent: { ...f.native.agent, worker: { ...f.native.agent.worker, groups: ['coding'] } },
    });
    await f.write(f.paths.shared, {
      models: {
        coding: {
          model: 'fixture/beta',
          temperature: 0.4,
          top_p: 0.7,
          maxOutputTokens: 128,
          options: { phase: 'beta' },
        },
      },
      groups: { coding: { agent: { modelRef: 'coding' } } },
      profiles: {
        a: {
          models: {
            coding: { model: 'fixture/alpha', temperature: 0.6, maxOutputTokens: 64, options: { phase: 'alpha' } },
          },
        },
      },
    });
    await f.host.start();
    const original = await request(f, 'worker');
    assert.equal(original.captured.max_tokens, 128);
    for (const model of [
      { providerID: 'fixture', modelID: 'alpha' },
      { providerID: 'other', modelID: 'beta' },
    ]) {
      const sent = await request(f, 'worker', { sessionID: original.sessionID, model });
      assert.equal(sent.info.providerID, model.providerID);
      assert.equal(sent.info.modelID, model.modelID);
      assert.equal(sent.captured.phase, undefined);
      assert.notEqual(sent.captured.temperature, 0.4);
      assert.notEqual(sent.captured.top_p, 0.7);
      assert.notEqual(sent.captured.max_tokens, 128);
    }
    await f.editor.applySelection(await f.editor.select('a'));
    const retained = await request(f, 'worker', {
      sessionID: original.sessionID,
      model: { providerID: 'fixture', modelID: 'beta' },
    });
    assert.equal(retained.info.modelID, 'beta');
    assert.equal(retained.captured.phase, undefined);
    assert.notEqual(retained.captured.max_tokens, 128);
    assert.notEqual(retained.captured.max_tokens, 64);
    const current = await request(f, 'worker');
    assert.equal(current.captured.model, 'alpha');
    assert.equal(current.captured.temperature, 0.6);
    assert.equal(current.captured.max_tokens, 64);
    assert.equal(current.captured.phase, 'alpha');
  },
);

test(
  'installed alias defaults preserve zero-valued agent settings, authored options and selected native variants',
  { timeout: 240000 },
  async (t) => {
    const f = await parameterFixture(t, 'native-model-parameters-authority');
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        ...f.native.agent,
        worker: { ...f.native.agent.worker, groups: ['coding'] },
        helper: {
          ...f.native.agent.helper,
          groups: ['coding'],
          temperature: 0,
          top_p: 0,
          options: { falseFlag: false },
        },
        explicit: { mode: 'primary', groups: ['coding', 'explicit'] },
      },
    });
    await mkdir(join(f.host.configRoot, 'agents'));
    const empty = '---\ngroups: [coding]\ntemperature: 0\ntop_p: 0\noptions: {}\n---\nNATIVE_EMPTY_OPTIONS';
    const pinned = '---\ngroups: [coding]\noptions:\n  falseFlag: false\n  empty: {}\n---\nNATIVE_PINNED_OPTIONS';
    await writeFile(join(f.host.configRoot, 'agents/empty.md'), empty);
    await writeFile(join(f.host.configRoot, 'agents/pinned.md'), pinned);
    await f.write(f.paths.shared, {
      models: {
        coding: {
          model: 'fixture/beta',
          temperature: 0.4,
          top_p: 0.7,
          maxOutputTokens: 128,
          options: { phase: 'alias', falseFlag: true, empty: { alias: true }, reasoningEffort: 'low' },
        },
      },
      groups: { coding: { agent: { modelRef: 'coding' } }, explicit: { agent: { temperature: 0, top_p: 0 } } },
    });
    await f.host.start();
    const defaults = (await request(f, 'worker')).captured;
    assert.equal(defaults.reasoning_effort, 'low');
    assert.equal(defaults.falseFlag, true);
    const variant = (await request(f, 'worker', { variant: 'high' })).captured;
    assert.equal(variant.reasoning_effort, 'high');
    assert.equal(variant.phase, 'alias');
    for (const agent of ['helper', 'explicit', 'empty']) {
      const sent = (await request(f, agent)).captured;
      assert.equal(sent.temperature, 0, `${agent} keeps its explicit temperature`);
      assert.equal(sent.top_p, 0, `${agent} keeps its explicit top_p`);
      if (agent === 'helper') {
        assert.equal(sent.falseFlag, false);
      }
      if (agent === 'empty') {
        assert.equal(sent.phase, undefined);
        assert.equal(sent.reasoning_effort, undefined);
        assert.equal(sent.falseFlag, undefined);
      }
    }
    const authored = (await request(f, 'pinned')).captured;
    assert.equal(authored.falseFlag, false);
    assert.deepEqual(authored.empty, {});
    assert.equal(authored.phase, undefined);
    assert.equal(authored.reasoning_effort, undefined);
    assert.equal(await readFile(join(f.host.configRoot, 'agents/empty.md'), 'utf8'), empty);
    assert.equal(await readFile(join(f.host.configRoot, 'agents/pinned.md'), 'utf8'), pinned);
  },
);

test(
  'installed later literal models clear alias bundles and profile-only aliases restore Shared only defaults',
  { timeout: 240000 },
  async (t) => {
    const f = await parameterFixture(t, 'native-model-parameters-reset');
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        worker: { ...f.native.agent.worker, groups: ['coding', 'literal'] },
        helper: { ...f.native.agent.helper, groups: ['literal', 'coding'] },
        named: { mode: 'primary', groups: ['coding'] },
        profileOnly: { mode: 'primary', groups: ['profileOnly'], model: 'fixture/alpha' },
      },
    });
    await f.write(f.paths.shared, {
      models: {
        coding: { model: 'fixture/beta', temperature: 0.4, maxOutputTokens: 128, options: { phase: 'coding' } },
      },
      groups: {
        coding: { agent: { modelRef: 'coding' } },
        literal: { agent: { model: 'fixture/beta' } },
        profileOnly: { agent: { modelRef: 'only' } },
      },
      agent: { named: { model: 'fixture/beta' } },
      profiles: {
        a: { models: { only: { model: 'fixture/beta', maxOutputTokens: 64, options: { phase: 'only' } } } },
      },
    });
    await f.host.start();
    for (const agent of ['worker', 'named']) {
      const sent = (await request(f, agent)).captured;
      assert.equal(sent.model, 'beta');
      assert.notEqual(sent.temperature, 0.4);
      assert.notEqual(sent.max_tokens, 128);
      assert.equal(sent.phase, undefined);
    }
    const reverse = (await request(f, 'helper')).captured;
    assert.equal(reverse.max_tokens, 128);
    assert.equal(reverse.phase, 'coding');
    for (const choice of ['a', null, 'a', null] as const) {
      await f.editor.applySelection(await f.editor.select(choice));
      const sent = (await request(f, 'profileOnly')).captured;
      assert.equal(sent.model, choice === 'a' ? 'beta' : 'alpha');
      assert.equal(sent.phase, choice === 'a' ? 'only' : undefined);
      if (choice === 'a') {
        assert.equal(sent.max_tokens, 64);
      } else {
        assert.notEqual(sent.max_tokens, 64);
      }
    }
  },
);
