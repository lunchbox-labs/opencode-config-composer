import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';
import { systemPrompt } from './content-editor.ts';

async function profileFixture(t: TestContext, name: string) {
  const f = await compositionFixture(t, name);
  const nativePath = join(f.host.configRoot, 'opencode.jsonc');
  const definitions = join(f.host.configRoot, 'definitions/reusable.jsonc');
  const native = JSON.parse(await readFile(nativePath, 'utf8')) as { agent: Record<string, unknown> };
  const nativeOptions = {
    user: 'native-user',
    logit_bias: { '101': 1 },
    customTree: { native: true, protected: 'native' },
  };
  native.agent.worker = { mode: 'primary', prompt: 'NATIVE_WORKER', options: nativeOptions };
  native.agent.pinned = {
    mode: 'primary',
    prompt: 'NATIVE_PINNED',
    model: 'fixture/beta',
    variant: 'low',
    temperature: 0.65,
    top_p: 0.75,
    options: { user: 'pinned-user', customTree: { protected: 'pin' } },
  };
  await writeFile(nativePath, JSON.stringify(native));
  await f.write(definitions, {
    components: {
      agents: {
        component: {
          mode: 'primary',
          prompt: 'COMPONENT_BODY',
          configuration: {
            parameters: { options: { customTree: { component: true }, logit_bias: { '505': 5 } } },
          },
        },
      },
    },
    componentGroups: { members: { agents: ['worker', 'component', 'pinned'] } },
    configurationPresets: {
      a: {
        model: 'fixture/alpha',
        variant: 'high',
        parameters: {
          temperature: 0.2,
          topP: 0.9,
          maxOutputTokens: 96,
          options: {
            user: 'a-user',
            logit_bias: { '202': 2 },
            aOnly: true,
            customTree: { aOnly: 'a', value: 'a', protected: 'composer' },
          },
        },
      },
      b: {
        model: 'fixture/alpha',
        parameters: {
          topP: 0.5,
          options: { logit_bias: { '303': 3 }, bOnly: true, customTree: { bOnly: 'b', value: 'b' } },
        },
      },
    },
    profiles: {
      a: {
        layers: [{ componentGroup: 'members' }, { configurationPreset: 'a', target: { componentGroups: ['members'] } }],
        overrides: { agents: { component: { prompt: { append: ['A_PROMPT'] } } } },
      },
      b: {
        layers: [{ componentGroup: 'members' }, { configurationPreset: 'b', target: { componentGroups: ['members'] } }],
      },
    },
  });
  await f.write(f.paths.shared, {
    imports: ['./definitions/reusable.jsonc'],
    defaults: {
      model: 'fixture/alpha',
      small_model: 'fixture/beta',
      agents: {
        parameters: {
          topP: 0.8,
          options: { baseOnly: true, customTree: { base: true, value: 'base' }, logit_bias: { '404': 4 } },
        },
        prompt: { prepend: ['BASE_PROMPT'] },
      },
    },
  });
  await f.write(f.paths.local, { activeProfiles: [] });
  await f.host.start();
  const original = await f.send();
  const originalHistory = await f.history(original.session.id);
  const pinned = await f.send(undefined, 'pinned');
  const preservedPaths = [nativePath, definitions, f.paths.shared];
  // OpenCode may insert its schema during initial loading. Freeze initialized bytes.
  const preservedBytes = await Promise.all(preservedPaths.map((path) => readFile(path, 'utf8')));
  const nativeBaseline = (await f.editor.runtime()).baseline;
  const localMetadata = await f.document(f.paths.local);
  delete localMetadata.activeProfiles;
  const unchanged = async () => {
    assert.deepEqual(await Promise.all(preservedPaths.map((path) => readFile(path, 'utf8'))), preservedBytes);
    const local = await f.document(f.paths.local);
    delete local.activeProfiles;
    assert.deepEqual(local, localMetadata, 'selection edits leave all other local metadata unchanged');
    assert.match(await readFile(f.paths.local, 'utf8'), /Preserve fixture comments/);
    assert.equal(
      await stat(f.paths.project).catch(() => undefined),
      undefined,
      'selection never creates a project source',
    );
    assert.deepEqual((await f.editor.runtime()).baseline, nativeBaseline, 'each apply retains original native inputs');
    const config = await f.host.api<{ agent: Record<string, { options?: unknown }> }>('/config');
    assert.deepEqual(
      config.agent.worker.options,
      nativeOptions,
      'model-bound custom controls do not mutate native agent options',
    );
  };
  const select = async (profiles: string[]) => {
    const requests = f.host.requests.length;
    const history = await f.history(original.session.id);
    await f.saveScope('local', { operation: 'selection', profiles });
    assert.deepEqual((await f.document(f.paths.local)).activeProfiles, profiles);
    await f.editor.reload();
    assert.equal(f.host.requests.length, requests, 'selection and scoped apply send no provider request');
    assert.deepEqual(
      await f.history(original.session.id),
      history,
      'selection and apply retain every conversation record',
    );
    await unchanged();
    const snapshot = await f.editor.snapshot();
    const config = await f.host.api<{
      model?: string;
      small_model?: string;
      default_agent?: string;
      agent: Partial<Record<string, { model?: string; variant?: string }>>;
    }>('/config');
    assert.equal(config.model, snapshot.resolved.model, 'native model updates before any continuation');
    assert.equal(
      config.small_model,
      snapshot.resolved.small_model,
      'native small_model updates before any continuation',
    );
    assert.equal(config.default_agent, snapshot.resolved.default_agent, 'native default agent remains consistent');
    for (const name of ['worker', 'component', 'pinned']) {
      const expected = Object.hasOwn(snapshot.resolved.agent, name) ? snapshot.resolved.agent[name] : undefined;
      assert.equal(config.agent[name]?.model, expected?.model, `${name} model is applied immediately`);
      assert.equal(config.agent[name]?.variant, expected?.variant, `${name} variant is applied immediately`);
    }
    assert.equal(
      Object.hasOwn(config.agent, 'component'),
      Object.hasOwn(snapshot.resolved.agent, 'component'),
      'component selection is applied before any continuation',
    );
    assert.equal(f.host.requests.length, requests, 'immediate config checks require no model request');
    return snapshot;
  };
  const continuation = async (agent = 'worker') => {
    // Public native message requests omit model/variant so the destination agent
    // determines dispatch. The TUI's separate session choice is not substituted.
    const previousHistory = await f.history(original.session.id);
    const next = await f.send(agent === 'worker' ? original.session.id : undefined, agent);
    const history = await f.history(original.session.id);
    assert.deepEqual(
      history.slice(0, originalHistory.length),
      originalHistory,
      'all original message records are retained',
    );
    assert.deepEqual(
      history.slice(0, previousHistory.length),
      previousHistory,
      'all previous continuations are retained',
    );
    if (agent === 'worker') {
      assert.ok(history.some((message) => message.info.id === next.message.info.id));
      assert.ok(history.length > previousHistory.length, 'the same conversation appends the new continuation');
    } else {
      assert.deepEqual(
        history,
        previousHistory,
        'another agent’s separate session does not alter the original history',
      );
    }
    assert.equal(
      (await f.host.api<{ title: string }>(`/session/${original.session.id}`)).title,
      'Acceptance conversation',
    );
    return next.captured;
  };
  const pinnedUnchanged = async () => {
    const next = (await f.send(pinned.session.id, 'pinned')).captured;
    for (const key of ['model', 'temperature', 'top_p', 'reasoning_effort', 'user', 'logit_bias']) {
      assert.deepEqual(next[key], pinned.captured[key], `native pinned ${key} is preserved`);
    }
    assert.equal(next.model, 'beta');
    assert.equal(next.temperature, 0.65);
    assert.equal(next.top_p, 0.75);
    assert.equal(next.reasoning_effort, 'low');
    assert.equal(next.user, 'pinned-user');
  };
  return { ...f, original, nativeOptions, select, continuation, pinnedUnchanged, unchanged };
}

test(
  'packaged native same-model A → B → A → none clears old profile settings and preserves base, native pins and original conversation records',
  { timeout: 240_000 },
  async (t) => {
    const f = await profileFixture(t, 'profile-recomposition');
    assert.equal(f.original.captured.model, 'alpha');
    assert.equal(f.original.captured.user, 'native-user');
    assert.deepEqual(f.original.captured.logit_bias, { '101': 1 });

    const a = await f.select(['a']);
    assert.equal(a.resolved.choices.worker.variant, 'high');
    assert.deepEqual(a.resolved.choices.worker.parameters, {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 96,
      options: {
        baseOnly: true,
        user: 'a-user',
        logit_bias: { '202': 2, '404': 4 },
        aOnly: true,
        customTree: { base: true, value: 'a', aOnly: 'a', protected: 'composer' },
      },
    });
    const firstA = await f.continuation();
    assert.equal(firstA.model, 'alpha');
    assert.equal(firstA.temperature, 0.2);
    assert.equal(firstA.top_p, 0.9);
    assert.equal(firstA.max_tokens, 96);
    assert.equal(firstA.reasoning_effort, 'high');
    assert.equal(firstA.user, 'native-user', 'native explicit options retain their protected value');
    assert.deepEqual(firstA.logit_bias, { '101': 1, '202': 2, '404': 4 });
    // The pinned compatible adapter passes extra options through to this captured
    // request. These assertions establish transport, not a remote model's schema.
    assert.deepEqual(firstA.customTree, { native: true, protected: 'native', base: true, value: 'a', aOnly: 'a' });
    assert.equal(firstA.aOnly, true);
    assert.equal(firstA.bOnly, undefined);
    const firstComponentA = await f.continuation('component');
    assert.equal(firstComponentA.user, 'a-user');
    assert.deepEqual(firstComponentA.logit_bias, { '202': 2, '404': 4, '505': 5 });
    assert.deepEqual(firstComponentA.customTree, {
      base: true,
      component: true,
      value: 'a',
      aOnly: 'a',
      protected: 'composer',
    });
    assert.match(systemPrompt(firstComponentA), /A_PROMPT/);
    await f.pinnedUnchanged();

    const b = await f.select(['b']);
    assert.equal(b.resolved.choices.worker.model, 'fixture/alpha');
    assert.equal(
      b.resolved.choices.worker.variant,
      undefined,
      'B omits A’s variant even though the model is unchanged',
    );
    assert.deepEqual(b.resolved.choices.worker.parameters, {
      topP: 0.5,
      options: {
        baseOnly: true,
        logit_bias: { '303': 3, '404': 4 },
        bOnly: true,
        customTree: { base: true, value: 'b', bOnly: 'b' },
      },
    });
    assert.deepEqual(b.resolved.choices.component.parameters?.options?.customTree, {
      base: true,
      component: true,
      value: 'b',
      bOnly: 'b',
    });
    const activeB = await f.continuation();
    assert.equal(activeB.model, 'alpha');
    assert.equal(
      activeB.temperature,
      f.original.captured.temperature,
      'A-only typed temperature returns to native fallback',
    );
    assert.equal(activeB.max_tokens, f.original.captured.max_tokens, 'A-only output limit returns to native fallback');
    assert.equal(
      activeB.reasoning_effort,
      f.original.captured.reasoning_effort,
      'A-only variant is absent in actual dispatch',
    );
    assert.equal(activeB.top_p, 0.5);
    assert.equal(activeB.user, 'native-user');
    assert.deepEqual(activeB.logit_bias, { '101': 1, '303': 3, '404': 4 });
    assert.deepEqual(activeB.customTree, { native: true, protected: 'native', base: true, value: 'b', bOnly: 'b' });
    assert.equal(activeB.aOnly, undefined, 'A-only custom scalar is absent in B’s actual request');
    assert.equal(activeB.bOnly, true);
    const componentB = await f.continuation('component');
    assert.equal(componentB.user, undefined, 'A-only transported custom user disappears for B');
    assert.deepEqual(componentB.logit_bias, { '303': 3, '404': 4, '505': 5 });
    assert.deepEqual(componentB.customTree, { base: true, component: true, value: 'b', bOnly: 'b' });
    assert.ok(!systemPrompt(componentB).includes('A_PROMPT'));
    await f.pinnedUnchanged();

    const again = await f.select(['a']);
    assert.deepEqual(
      again.resolved.choices,
      a.resolved.choices,
      'returning to A exactly reconstructs its original choices',
    );
    const restored = await f.continuation();
    for (const key of [
      'model',
      'temperature',
      'top_p',
      'max_tokens',
      'reasoning_effort',
      'user',
      'logit_bias',
      'customTree',
      'baseOnly',
      'aOnly',
      'bOnly',
    ]) {
      assert.deepEqual(restored[key], firstA[key], `returning to A exactly restores request ${key}`);
    }
    await f.pinnedUnchanged();

    const none = await f.select([]);
    assert.equal(none.resolved.choices.worker, undefined);
    assert.equal(none.resolved.choices.component, undefined);
    const cleared = await f.continuation();
    for (const key of [
      'model',
      'temperature',
      'top_p',
      'max_tokens',
      'reasoning_effort',
      'user',
      'logit_bias',
      'customTree',
      'baseOnly',
      'aOnly',
      'bOnly',
    ]) {
      assert.deepEqual(cleared[key], f.original.captured[key], `clear restores native request ${key}`);
    }
    assert.ok(!systemPrompt(cleared).includes('BASE_PROMPT'));
    assert.match(systemPrompt(cleared), /NATIVE_WORKER/, 'clear retains the original native prompt in dispatch');
    const config = await f.host.api<{ agent: Record<string, unknown>; model: string; small_model: string }>('/config');
    assert.equal(config.agent.component, undefined, 'clear removes the profile-selected component agent');
    assert.equal(config.model, 'fixture/alpha');
    assert.equal(config.small_model, 'fixture/beta', 'clear retains source base globals');
    await f.pinnedUnchanged();
    await f.unchanged();
  },
);

test(
  'packaged native current ordered profiles merge same-model contributions while switching to B removes deselected A values',
  { timeout: 240_000 },
  async (t) => {
    const f = await profileFixture(t, 'profile-recomposition-order');
    const first = await f.select(['a', 'b']);
    assert.deepEqual(first.sources.activeProfiles, ['a', 'b']);
    assert.deepEqual(first.resolved.choices.worker.parameters?.options?.customTree, {
      base: true,
      aOnly: 'a',
      bOnly: 'b',
      protected: 'composer',
      value: 'b',
    });
    const ordered = await f.continuation();
    assert.equal(ordered.temperature, 0.2, 'A remains part of the current selection');
    assert.equal(ordered.top_p, 0.5, 'B wins the current order’s overlapping typed value');
    assert.equal(ordered.max_tokens, 96);
    assert.equal(ordered.reasoning_effort, 'high');
    assert.deepEqual(ordered.logit_bias, { '101': 1, '202': 2, '303': 3, '404': 4 });
    assert.deepEqual(ordered.customTree, {
      native: true,
      protected: 'native',
      base: true,
      value: 'b',
      aOnly: 'a',
      bOnly: 'b',
    });

    const reversed = await f.select(['b', 'a']);
    assert.deepEqual(reversed.sources.activeProfiles, ['b', 'a']);
    assert.deepEqual(reversed.resolved.choices.worker.parameters?.options?.customTree, {
      base: true,
      aOnly: 'a',
      bOnly: 'b',
      protected: 'composer',
      value: 'a',
    });
    const reverse = await f.continuation();
    assert.equal(reverse.top_p, 0.9, 'A wins the reversed order’s overlapping typed value');
    assert.equal(reverse.temperature, 0.2);
    assert.equal(reverse.max_tokens, 96);
    assert.equal(reverse.reasoning_effort, 'high');
    assert.deepEqual(
      reverse.logit_bias,
      ordered.logit_bias,
      'both currently selected profiles retain their nested leaves',
    );
    assert.deepEqual(reverse.customTree, {
      native: true,
      protected: 'native',
      base: true,
      value: 'a',
      aOnly: 'a',
      bOnly: 'b',
    });

    const b = await f.select(['b']);
    assert.equal(b.resolved.choices.worker.variant, undefined);
    assert.deepEqual(b.resolved.choices.worker.parameters?.options?.customTree, { base: true, value: 'b', bOnly: 'b' });
    const onlyB = await f.continuation();
    assert.equal(onlyB.temperature, f.original.captured.temperature);
    assert.equal(onlyB.max_tokens, f.original.captured.max_tokens);
    assert.equal(onlyB.reasoning_effort, f.original.captured.reasoning_effort);
    assert.equal(onlyB.top_p, 0.5);
    assert.deepEqual(onlyB.logit_bias, { '101': 1, '303': 3, '404': 4 });
    assert.deepEqual(onlyB.customTree, { native: true, protected: 'native', base: true, value: 'b', bOnly: 'b' });
    assert.equal(onlyB.aOnly, undefined);
    await f.pinnedUnchanged();
    await f.unchanged();
  },
);
