import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';
test(
  'installed profile A B A none default lifecycle confirms revisions, native fields and command dispatch',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'profile-lifecycle');
    await f.write(f.paths.shared, {
      groups: [{ name: 'workers', members: { agent: ['worker'] }, agent: { temperature: 0.3 } }],
      profiles: {
        a: {
          agent: { worker: { model: 'fixture/beta', variant: 'high', options: { a: false } } },
          command: { review: { agent: 'worker', model: 'fixture/beta', subtask: false } },
        },
        b: {
          agent: { worker: { model: 'fixture/alpha' } },
          command: { review: { agent: 'helper', model: 'fixture/alpha', subtask: true } },
        },
      },
      defaultProfile: 'a',
    });
    const bytes = await readFile(f.paths.native, 'utf8');
    await f.host.start();
    let previous = await f.editor.runtime();
    for (const choice of ['a', 'b', 'a', null, undefined] as const) {
      const committed = await f.editor.select(choice);
      assert.equal(committed.selection.choice, choice);
      const revision = await f.editor.reload(committed);
      const runtime = await f.editor.runtime();
      assert.notEqual(runtime.id, previous.id);
      assert.deepEqual(runtime.revision, revision);
      previous = runtime;
      const config = await f.host.api<{
        agent: Record<string, Record<string, unknown>>;
        command: Record<string, Record<string, unknown>>;
      }>('/config');
      const active = choice === undefined ? 'a' : choice;
      assert.equal(
        config.agent.worker.model,
        active === 'a' ? 'fixture/beta' : active === 'b' ? 'fixture/alpha' : undefined,
      );
      assert.equal(config.agent.worker.variant, active === 'a' ? 'high' : undefined);
      assert.equal((config.agent.worker.options as Record<string, unknown>).a, active === 'a' ? false : undefined);
      assert.equal(config.agent.worker.temperature, 0.3);
      assert.equal(config.agent.worker.prompt, 'NATIVE_WORKER');
      assert.equal(config.command.review.subtask, active !== 'a');
      assert.equal(config.command.review.agent, active === 'b' ? 'helper' : 'worker');
      assert.equal(config.command.review.model, active === 'a' ? 'fixture/beta' : 'fixture/alpha');
      const agents = await f.host.api<{ name: string; model?: { modelID: string } }[]>('/agent');
      assert.equal(
        agents.find((agent) => agent.name === 'worker')?.model?.modelID,
        active === 'a' ? 'beta' : active === 'b' ? 'alpha' : undefined,
      );
      const commands = await f.host.api<{ name: string; subtask: boolean; model: string }[]>('/command');
      assert.equal(commands.find((command) => command.name === 'review')?.subtask, active !== 'a');
    }
    const session = await f.host.api<{ id: string }>('/session', { title: 'Declared native command' });
    const before = f.host.requests.length;
    const response = await f.host.api<{ info: { error?: unknown } }>(`/session/${session.id}/command`, {
      command: 'review',
      arguments: 'dispatch proof',
    });
    assert.equal(response.info.error, undefined);
    assert.ok(
      f.host.requests
        .slice(before)
        .some(
          (request) =>
            request.model === 'beta' && JSON.stringify(request.messages).includes('NATIVE_REVIEW dispatch proof'),
        ),
    );
    assert.equal(await readFile(f.paths.native, 'utf8'), bytes);
  },
);
