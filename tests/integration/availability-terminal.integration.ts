import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { availabilityFixture } from './availability-fixture.ts';
import { reloadFromTerminal } from './terminal-editor.ts';
import { nativeTerminal } from './terminal.ts';

test(
  'real terminal availability edits persist false and true, apply native fallback and retain the active conversation',
  { timeout: 240_000 },
  async (t) => {
    const f = await availabilityFixture(t, 'availability-terminal');
    await f.host.start();
    await f.select(['work']);
    const original = await f.send('worker');
    const terminal = await nativeTerminal(f.host, original.session.id, 'availability-terminal');
    await terminal.wait(['Availability conversation', 'verified', 'ctrl+p', 'commands']);

    const edit = async () => {
      await terminal.command('/compose', 'Compose');
      await terminal.choose('Author groups, presets and profiles', 'Composition definitions');
      await terminal.choose('Profiles', 'work');
      await terminal.choose('work', 'Profiles: work');
      await terminal.choose('Agent availability', 'work: agent availability', 'Save availability');
      assert.ok(!terminal.text().includes('title'), 'internal agents have no authoring toggle');
      assert.ok(!terminal.text().includes('summary'), 'internal agents have no authoring toggle');
      assert.ok(!terminal.text().includes('compaction'), 'internal agents have no authoring toggle');
    };
    const decide = async (name: string, enabled: boolean) => {
      await terminal.choose(
        name,
        `work: ${name}`,
        'Enable agent',
        'Disable agent',
        'Inherit earlier/native availability',
      );
      await terminal.choose(enabled ? 'Enable agent' : 'Disable agent', 'work: agent availability');
    };

    await edit();
    const before = await readFile(f.paths.shared, 'utf8');
    for (const name of ['build', 'worker', 'pinned', 'workflow']) {
      await decide(name, false);
    }
    assert.equal(await readFile(f.paths.shared, 'utf8'), before, 'draft toggles wait for reviewed save');
    await terminal.choose('Save availability', 'Save composition definition?', 'Native default: OpenCode fallback');
    assert.equal(await readFile(f.paths.shared, 'utf8'), before);
    await terminal.press('\r', 'Settings saved');
    const disabled = (await f.document(f.paths.shared)).profiles!.work.agentAvailability;
    assert.deepEqual(disabled, { build: false, worker: false, pinned: false, workflow: false });
    assert.equal(
      (await f.send('worker', original.session.id)).captured.model,
      'beta',
      'saving does not apply availability',
    );
    await reloadFromTerminal(f, terminal);
    for (const name of ['build', 'worker', 'pinned', 'workflow']) {
      assert.equal(await f.find(name), undefined, name);
    }
    await terminal.wait(['Plan', 'Fixture Beta']);
    const requestStart = f.host.requests.length;
    const existingMessages = new Set((await f.history(original.session.id)).map((message) => message.info.id));
    await terminal.command('Continue this availability conversation.', 'verified');
    // Earlier verified replies remain visible while the native prompt dispatches.
    // Observe completion of the new request before asserting its agent and model.
    let history: {
      info: { role: string; agent: string; id: string; error?: unknown; time: { completed?: number } };
      parts: { type: string; text?: string }[];
    }[] = [];
    for (let attempt = 0; attempt < 400; attempt++) {
      history = await f.host.api(`/session/${original.session.id}/message`);
      const last = history.at(-1)?.info;
      if (
        f.host.requests.length === requestStart + 1 &&
        last?.role === 'assistant' &&
        last.time.completed !== undefined
      ) {
        break;
      }
      await setTimeout(50);
    }
    assert.equal(f.host.requests.length, requestStart + 1, 'the fallback sends a real native provider request');
    const completed = history.filter((message) => message.info.role === 'assistant').at(-1);
    assert.ok(completed !== undefined, 'the fallback produces an assistant message');
    assert.ok(!existingMessages.has(completed.info.id), 'the fallback completes a new assistant message');
    assert.ok(completed.info.time.completed !== undefined, 'the new fallback assistant finishes before the deadline');
    assert.equal(completed.info.error, undefined, JSON.stringify(completed.info.error));
    assert.ok(completed.parts.some((part) => part.type === 'text' && part.text === 'verified'));
    assert.equal(completed.info.agent, 'plan');
    assert.equal(f.host.requests.at(-1)?.model, 'beta');

    await edit();
    for (const name of ['build', 'worker', 'pinned', 'workflow']) {
      await decide(name, true);
    }
    await terminal.choose('Save availability', 'Save composition definition?');
    await terminal.press('\r', 'Settings saved');
    assert.deepEqual((await f.document(f.paths.shared)).profiles!.work.agentAvailability, {
      build: true,
      worker: true,
      pinned: true,
      workflow: true,
    });
    assert.equal(await f.find('workflow'), undefined, 'save retains the disabled running revision');
    await reloadFromTerminal(f, terminal);
    assert.equal((await f.send('worker', original.session.id)).captured.model, 'beta');
    const workflow = await f.send('workflow');
    assert.equal(workflow.captured.model, 'alpha');
    assert.match(JSON.stringify(workflow.captured.messages), /WORKFLOW_BODY/);
    assert.equal((await f.send('build')).captured.model, 'beta');
    assert.equal((await f.send('pinned')).captured.model, 'alpha');
    for (const name of ['general', 'dormant', 'title', 'summary', 'unselected']) {
      assert.equal(await f.find(name), undefined, name);
    }
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));
    assert.match(await readFile(f.paths.shared, 'utf8'), /Preserve fixture comments/);
  },
);
