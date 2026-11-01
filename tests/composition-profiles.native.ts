import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';
test(
  'installed profile A B A none default lifecycle confirms revisions, native fields and command dispatch',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'profile-lifecycle');
    await f.write(f.paths.native, {
      ...f.native,
      agent: { ...f.native.agent, worker: { ...f.native.agent.worker, groups: ['workers'] } },
    });
    await f.write(f.paths.shared, {
      groups: { workers: { agent: { temperature: 0.3 } } },
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
      const revision = await f.editor.applySelection(committed);
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

test(
  'installed profile steps reach native agents across repeated hooks while frontmatter steps stay final',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'profile-steps');
    await f.write(f.paths.native, {
      ...f.native,
      agent: { ...f.native.agent, worker: { ...f.native.agent.worker, groups: ['workers'] } },
    });
    const global = join(f.host.configRoot, 'agents');
    const project = join(f.host.project, '.opencode', 'agents');
    await mkdir(global);
    await mkdir(project, { recursive: true });
    // Native decodes each Markdown source's deprecated maxSteps as its steps value before merging sources,
    // so a later maxSteps replaces an earlier source's steps.
    const files = {
      [join(global, 'pinned.md')]: '---\ngroups: [workers]\nsteps: 5\n---\nPINNED_BODY',
      [join(global, 'deprecated.md')]: '---\ngroups: [workers]\nmaxSteps: 4\n---\nDEPRECATED_BODY',
      [join(global, 'crossed.md')]: '---\ngroups: [workers]\nsteps: 5\n---\nCROSSED_BODY',
      [join(project, 'crossed.md')]: '---\nmaxSteps: 2\n---\nCROSSED_PROJECT_BODY',
    };
    for (const [path, body] of Object.entries(files)) {
      await writeFile(path, body);
    }
    await f.write(f.paths.shared, {
      groups: { workers: {} },
      profiles: { capped: { groups: { workers: { agent: { steps: 1 } } } }, open: {} },
    });
    const nativeBytes = await readFile(f.paths.native, 'utf8');
    await f.host.start();
    for (const choice of ['capped', 'open', 'capped', null] as const) {
      await f.editor.applySelection(await f.editor.select(choice));
      const capped = choice === 'capped';
      const config = await f.host.api<{ agent: Record<string, Record<string, unknown>> }>('/config');
      assert.deepEqual(
        ['worker', 'pinned', 'deprecated', 'crossed'].map((name) => config.agent[name].steps),
        [capped ? 1 : undefined, 5, 4, 2],
      );
      // Native /agent reports an unset configured agent's steps as null.
      const agents = await f.host.api<{ name: string; steps?: number | null }[]>('/agent');
      assert.deepEqual(
        ['worker', 'pinned', 'deprecated', 'crossed'].map((name) => agents.find((agent) => agent.name === name)?.steps),
        [capped ? 1 : null, 5, 4, 2],
      );
      const { decisions } = (await f.editor.runtime()).candidate!;
      assert.equal(
        Object.hasOwn(decisions, '/agent/worker/steps') ? decisions['/agent/worker/steps'].origin.pointer : undefined,
        capped ? '/profiles/capped/groups/workers/agent/steps' : undefined,
      );
      for (const name of ['pinned', 'deprecated', 'crossed']) {
        const decision = decisions[`/agent/${name}/steps`];
        assert.equal(decision.origin.kind, 'frontmatter', name);
        assert.equal(decision.value, agents.find((agent) => agent.name === name)?.steps, name);
        assert.equal(decision.blockedComposer?.value, capped ? 1 : undefined, name);
      }
      // The native loop switches to text-only output on the configured final step.
      const { captured } = await f.send('worker');
      assert.equal(JSON.stringify(captured.messages).includes('MAXIMUM STEPS REACHED'), capped);
    }
    for (const [path, body] of Object.entries(files)) {
      assert.equal(await readFile(path, 'utf8'), body);
    }
    assert.equal(await readFile(f.paths.native, 'utf8'), nativeBytes);
  },
);
