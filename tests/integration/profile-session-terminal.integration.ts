import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { compositionFixture } from './composition-fixture.ts';
import { httpRelay } from './http-relay.ts';
import { nativeTerminal } from './terminal.ts';

interface Message {
  info: {
    id: string;
    role: string;
    agent: string;
    error?: unknown;
    model?: { providerID: string; modelID: string; variant?: string };
    time: { completed?: number };
  };
  parts: { type: string; text?: string }[];
}

interface Prompt {
  agent: string;
  model: { providerID: string; modelID: string };
  variant?: string;
}

test(
  'native model-state API limits: profile apply warns and supported user actions repair restored selections',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'profile-session-terminal');
    const nativePath = join(f.host.configRoot, 'opencode.jsonc');
    const native = JSON.parse(await readFile(nativePath, 'utf8')) as { agent: Record<string, unknown> };
    native.agent.title = { disable: true };
    await writeFile(nativePath, JSON.stringify(native));
    await f.write(f.paths.shared, {
      componentGroups: {
        a: {
          agents: ['worker'],
          configuration: {
            model: 'fixture/alpha',
            variant: 'high',
            parameters: { temperature: 0.23, topP: 0.61, options: { aOnly: 'profile-A' } },
          },
        },
        b: { agents: ['worker'], configuration: { model: 'fixture/alpha' } },
        c: { agents: ['worker'], configuration: { model: 'fixture/beta' } },
      },
      profiles: {
        a: { layers: [{ componentGroup: 'a' }] },
        b: { layers: [{ componentGroup: 'b' }] },
        c: { layers: [{ componentGroup: 'c' }] },
      },
      activeProfiles: ['a'],
    });
    await f.host.start();

    // Both seeds omit model and variant in the native prompt. The stored A tuple
    // originates in the profile; the user has not opened either native picker.
    const original = await f.send();
    const runtimeSession = await f.send();
    assert.equal(original.captured.model, 'alpha');
    assert.equal(original.captured.reasoning_effort, 'high');
    assert.equal(original.captured.temperature, 0.23);
    assert.equal(original.captured.top_p, 0.61);
    assert.equal(original.captured.aOnly, 'profile-A');
    const history = () => f.host.api<Message[]>(`/session/${original.session.id}/message`);
    const originalHistory = await history();
    const originalModel = originalHistory.find((message) => message.info.role === 'user')?.info.model;
    assert.deepEqual(originalModel, { providerID: 'fixture', modelID: 'alpha', variant: 'high' });

    const relay = await httpRelay(t, () => f.host.url);
    const terminal = await nativeTerminal(
      { ...f.host, url: relay.url },
      original.session.id,
      'profile-session-terminal',
    );
    await terminal.wait(['Acceptance conversation', 'verified', 'ctrl+p', 'commands']);
    const nativeFiles = [nativePath, join(f.host.configRoot, 'tui.jsonc')];
    const nativeBytes = await Promise.all(nativeFiles.map((path) => readFile(path)));
    const unchangedNativeFiles = async () => {
      const current = await Promise.all(nativeFiles.map((path) => readFile(path)));
      assert.deepEqual(current, nativeBytes, 'profile apply leaves native JSON and TUI configuration bytes unchanged');
    };
    const warning = async (stage: string) => {
      const labels = [
        'Clearing profiles can retain a previous model',
        'native session fallback',
        'cannot reset',
        'model or variant',
        '/models',
        '/variants',
        'Default',
      ];
      for (let attempt = 0; attempt < 160; attempt++) {
        const rows = terminal.text().split('\n');
        let visible = rows.join('\n');
        if (stage === 'Apply confirmation') {
          const title = rows.findIndex((row) => row.includes('Apply saved revision?'));
          if (title !== -1) {
            const left = rows[title].indexOf('Apply saved revision?');
            const right = rows[title].indexOf('esc', left);
            const actions = rows.findIndex(
              (row, index) => index > title && row.includes('Cancel') && row.includes('Confirm'),
            );
            if (right !== -1 && actions !== -1) {
              visible = rows
                .slice(title, actions + 1)
                .map((row) => row.slice(left, right))
                .join('\n');
            }
          }
        } else {
          // Read only the native toast rectangle: conversation/sidebar text and
          // borders otherwise interrupt phrases that wrap onto its next row.
          const title = rows.findIndex((row) => row.includes('Composer revision applied'));
          if (title !== -1) {
            const titleColumn = rows[title].indexOf('Composer revision applied');
            const left = rows[title].lastIndexOf('┃', titleColumn);
            const right = rows[title].indexOf('┃', titleColumn);
            if (left !== -1 && right !== -1) {
              const content: string[] = [];
              for (let row = title; row < rows.length && rows[row][left] === '┃' && rows[row][right] === '┃'; row++) {
                content.push(rows[row].slice(left + 1, right));
              }
              visible = content.join('\n');
            }
          }
        }
        // Native wrapping can split a command name between '/' and 'models'.
        const screen = visible.replace(/\s+/g, '');
        if (labels.every((label) => screen.includes(label.replace(/\s+/g, '')))) {
          return;
        }
        await setTimeout(50);
      }
      assert.fail(`${stage} must explain the native TUI reset limitation and manual recovery:\n${terminal.text()}`);
    };
    const apply = async (profiles: string[]) => {
      const previous = await f.editor.runtime();
      const messages = await history();
      await f.saveScope('shared', { operation: 'selection', profiles });
      await terminal.command('/reload-configs', 'Settings saved');
      await terminal.choose('Reload now', 'Apply saved revision?', 'only this instance');
      // The first assertion is deliberately bounded: old code only promised to
      // retain selections and did not tell users how to remove a profile seed.
      await warning('Apply confirmation');
      await terminal.press('\r', 'Composer revision applied');
      await warning('Apply toast');
      let applied = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const current = await f.editor.runtime();
        if (current.applied.id !== previous.applied.id) {
          assert.deepEqual(current.baseline, previous.baseline);
          applied = true;
          break;
        }
        await setTimeout(50);
      }
      assert.ok(applied, 'native scoped apply publishes a new Composer registration');
      const agents =
        await f.host.api<{ name: string; model?: { providerID: string; modelID: string }; variant?: string | null }[]>(
          '/agent',
        );
      const worker = agents.find((agent) => agent.name === 'worker');
      assert.ok(worker !== undefined);
      assert.equal(worker.variant ?? undefined, undefined, "the destination native agent no longer has A's variant");
      assert.deepEqual(
        worker.model,
        profiles.length === 0 ? undefined : { providerID: 'fixture', modelID: profiles[0] === 'c' ? 'beta' : 'alpha' },
        'the native agent follows the destination or restores its model-free baseline',
      );
      const config = await f.host.api<{ model: string }>('/config');
      assert.equal(config.model, 'fixture/alpha', 'the native global fallback remains the running baseline');
      assert.deepEqual(await history(), messages, 'applying a profile does not rewrite conversation history');
      await unchangedNativeFiles();
    };
    const request = async (label: string) => {
      const previous = await history();
      const existing = new Set(previous.map((message) => message.info.id));
      const providerStart = f.host.requests.length;
      const transportStart = relay.requests.length;
      await terminal.command(`Continue ${label}.`);
      let messages: Message[] = [];
      for (let attempt = 0; attempt < 400; attempt++) {
        messages = await history();
        const last = messages.at(-1)?.info;
        if (
          f.host.requests.length === providerStart + 1 &&
          last?.role === 'assistant' &&
          !existing.has(last.id) &&
          last.time.completed !== undefined
        ) {
          break;
        }
        await setTimeout(50);
      }
      assert.equal(f.host.requests.length, providerStart + 1, 'one actual TUI dispatch reaches the local provider');
      const completed = messages.at(-1);
      assert.ok(completed !== undefined);
      assert.equal(completed.info.role, 'assistant');
      assert.ok(!existing.has(completed.info.id), 'the terminal finishes a new assistant message');
      assert.ok(completed.info.time.completed !== undefined, 'the new reply completes before the deadline');
      assert.equal(completed.info.error, undefined, JSON.stringify(completed.info.error));
      assert.equal(completed.info.agent, 'worker');
      assert.ok(completed.parts.some((part) => part.type === 'text' && part.text === 'verified'));
      const submitted = relay.requests
        .slice(transportStart)
        .filter((entry) => entry.method === 'POST' && entry.path === `/session/${original.session.id}/message`);
      assert.equal(submitted.length, 1, 'the relay observes the actual native TUI prompt');
      const input = JSON.parse(submitted[0].body.toString()) as Prompt;
      assert.equal(input.agent, 'worker');
      const user = messages.filter((message) => message.info.role === 'user').at(-1);
      assert.ok(user !== undefined && !existing.has(user.info.id));
      assert.equal(user.info.agent, 'worker');
      assert.deepEqual(messages.slice(0, previous.length), previous, 'the prompt retains all earlier message bytes');
      const captured = f.host.requests.at(-1)!;
      assert.equal(captured.model, input.model.modelID, 'the selected native TUI model reaches the actual provider');
      return { captured, input, user };
    };
    const profileParametersGone = (captured: Record<string, unknown>) => {
      assert.equal(captured.temperature, undefined);
      assert.equal(captured.top_p, undefined);
      assert.equal(captured.aOnly, undefined);
    };
    const implicit = async (model: string) => {
      const { captured } = await f.send(runtimeSession.session.id);
      assert.equal(captured.model, model);
      assert.equal(captured.reasoning_effort, undefined, "the destination does not inherit A's omitted variant");
      profileParametersGone(captured);
    };
    const tuple = (input: Prompt) => ({ model: input.model.modelID, variant: input.variant });
    const publicPicker = async (command: 'model.list' | 'variant.list', title: string) => {
      const previous = await history();
      const count = f.host.requests.length;
      const choice = { model: { providerID: 'fixture', modelID: 'beta' }, variant: 'default' };
      const response = await f.host.response('/tui/publish', {
        type: 'tui.command.execute',
        properties: { command, ...choice, payload: choice },
      });
      assert.equal(response.status, 200, 'the public native TUI command route accepts the event');
      assert.equal(await response.json(), true);
      await terminal.wait([title]);
      assert.deepEqual(await history(), previous, 'opening a public picker does not rewrite history');
      assert.equal(f.host.requests.length, count, 'opening a picker does not dispatch a provider request');
    };

    const restored = await request('A restored from profile history');
    assert.deepEqual(tuple(restored.input), { model: 'alpha', variant: 'high' });
    await apply(['b']);
    await implicit('alpha');
    const staleB = await request('B with the same model');
    assert.deepEqual(tuple(staleB.input), { model: 'alpha', variant: 'high' });
    assert.equal(
      staleB.captured.reasoning_effort,
      'high',
      'the native TUI still explicitly submits its restored variant',
    );
    profileParametersGone(staleB.captured);

    // The supported concrete session switch updates its row without changing
    // history, but it does not reset the native TUI's independent local choice.
    const beforeSwitch = await history();
    const switched = await f.host.response(`/api/session/${original.session.id}/model`, {
      model: { providerID: 'fixture', id: 'beta' },
    });
    assert.equal(switched.status, 204);
    const session = await f.host.api<{ model: { id: string; providerID: string } }>(`/session/${original.session.id}`);
    assert.deepEqual(session.model, { id: 'beta', providerID: 'fixture' });
    assert.deepEqual(await history(), beforeSwitch);
    const afterSwitch = await request('after the supported native session switch');
    assert.deepEqual(tuple(afterSwitch.input), { model: 'alpha', variant: 'high' });

    await terminal.command('/variants', 'Select variant');
    await terminal.choose('Default', 'ctrl+p', 'commands');
    const fixedB = await request('B after choosing Default');
    assert.deepEqual(tuple(fixedB.input), { model: 'alpha', variant: undefined });
    assert.equal(fixedB.captured.reasoning_effort, undefined);
    assert.equal(fixedB.user.info.model?.variant, undefined);
    profileParametersGone(fixedB.captured);

    await terminal.command('/models', 'Select model');
    await terminal.choose('Fixture Beta', 'Select variant');
    await terminal.choose('low', 'ctrl+p', 'commands');
    const cachedBeta = await request('a manual beta low selection');
    assert.deepEqual(tuple(cachedBeta.input), { model: 'beta', variant: 'low' });
    assert.equal(cachedBeta.captured.reasoning_effort, 'low');
    await terminal.command('/models', 'Select model');
    await terminal.choose('Fixture Alpha', 'ctrl+p', 'commands');
    await terminal.command('/variants', 'Select variant');
    await terminal.choose('high', 'ctrl+p', 'commands');
    const explicit = await request('a manual variant matching the original profile seed');
    assert.deepEqual(
      explicit.user.info.model,
      originalModel,
      'native history does not distinguish a manual pick from an automatic profile seed',
    );
    assert.deepEqual(tuple(explicit.input), tuple(restored.input));

    await apply(['c']);
    await implicit('beta');
    const staleC = await request('C with a different configured model');
    assert.deepEqual(tuple(staleC.input), { model: 'alpha', variant: 'high' });
    assert.equal(staleC.captured.model, 'alpha');
    profileParametersGone(staleC.captured);
    await publicPicker('model.list', 'Select model');
    await terminal.press('\x1b', 'ctrl+p', 'commands');
    const ignoredModelPayload = await request('C after cancelling the public model picker');
    assert.deepEqual(tuple(ignoredModelPayload.input), { model: 'alpha', variant: 'high' });
    await publicPicker('model.list', 'Select model');
    // A valid cached variant makes /models skip its variant picker. Selecting
    // both model and variant explicitly works for cached and unseen models.
    await terminal.choose('Fixture Beta', 'ctrl+p', 'commands');
    const cachedC = await request('C after choosing a model with a cached variant');
    assert.deepEqual(tuple(cachedC.input), { model: 'beta', variant: 'low' });
    assert.equal(cachedC.captured.reasoning_effort, 'low');
    await publicPicker('variant.list', 'Select variant');
    await terminal.press('\x1b', 'ctrl+p', 'commands');
    const ignoredVariantPayload = await request('C after cancelling the public variant picker');
    assert.deepEqual(tuple(ignoredVariantPayload.input), { model: 'beta', variant: 'low' });
    await publicPicker('variant.list', 'Select variant');
    await terminal.choose('Default', 'ctrl+p', 'commands');
    const fixedC = await request('C after choosing its model and Default');
    assert.deepEqual(tuple(fixedC.input), { model: 'beta', variant: undefined });
    assert.equal(fixedC.captured.model, 'beta');
    assert.equal(fixedC.captured.reasoning_effort, undefined);

    await apply([]);
    // Clearing Composer defaults cannot identify whether a native persisted
    // model was profile-owned or chosen by the user. Existing implicit callers
    // retain that native fallback until a supported concrete selection changes it.
    const storedClear = (await f.send(runtimeSession.session.id)).captured;
    assert.equal(storedClear.model, 'beta', 'an existing native session retains the stored C model after clear');
    assert.equal(storedClear.reasoning_effort, undefined);
    profileParametersGone(storedClear);
    const freshClear = (await f.send()).captured;
    assert.equal(freshClear.model, 'alpha', 'a fresh implicit session uses the restored native global fallback');
    assert.equal(freshClear.reasoning_effort, undefined);
    profileParametersGone(freshClear);
    const beforeClearSwitch = await history();
    const clearSwitch = await f.host.response(`/api/session/${original.session.id}/model`, {
      model: { providerID: 'fixture', id: 'alpha' },
    });
    assert.equal(clearSwitch.status, 204);
    const clearSession = await f.host.api<{ model: { id: string; providerID: string } }>(
      `/session/${original.session.id}`,
    );
    assert.deepEqual(clearSession.model, { id: 'alpha', providerID: 'fixture' });
    assert.deepEqual(await history(), beforeClearSwitch);
    const clearApi = (await f.send(original.session.id)).captured;
    assert.equal(clearApi.model, 'alpha', 'a supported concrete session switch repairs the next implicit HTTP model');
    assert.equal(clearApi.reasoning_effort, undefined);
    profileParametersGone(clearApi);
    const manualAfterClear = await request('clear with a manual native model choice');
    assert.deepEqual(tuple(manualAfterClear.input), { model: 'beta', variant: undefined });
    await terminal.command('/models', 'Select model');
    await terminal.choose('Fixture Alpha', 'ctrl+p', 'commands');
    await terminal.command('/variants', 'Select variant');
    await terminal.choose('Default', 'ctrl+p', 'commands');
    const fixedClear = await request('clear after choosing the native model and Default');
    assert.equal(fixedClear.captured.model, 'alpha');
    assert.equal(fixedClear.captured.reasoning_effort, undefined);
    profileParametersGone(fixedClear.captured);
    assert.deepEqual((await history()).slice(0, originalHistory.length), originalHistory);
    await unchangedNativeFiles();
  },
);
