import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { availabilityFixture } from './availability-fixture.ts';
import { bundledPermissions } from './bundled-permissions.ts';

test(
  'packaged availability changes native dispatch and fallback while retaining pins, native behavior and conversations',
  { timeout: 240_000 },
  async (t) => {
    const f = await availabilityFixture(t, 'availability-runtime');
    await f.host.start();
    const baselineBuild = await f.find('build');
    const baselinePlan = await f.find('plan');
    assert.ok(baselineBuild !== undefined && baselinePlan !== undefined);
    const nativeBytes = await readFile(f.nativePath, 'utf8');
    const normalize = await bundledPermissions(f.host);
    const original = await f.send();
    assert.equal(original.message.info.agent, 'build');
    assert.equal(original.captured.model, 'alpha');

    await t.test(
      'profile selection enables a dormant workflow without resurrecting native disabled agents',
      async () => {
        await f.select(['work']);
        for (const name of ['general', 'dormant', 'title', 'summary', 'unselected']) {
          assert.equal(await f.find(name), undefined, name);
        }
        assert.equal((await f.find('compaction'))?.hidden, true);
        assert.equal((await f.find('concealed'))?.hidden, true);
        assert.equal((await f.find('child'))?.mode, 'subagent');
        assert.deepEqual(normalize((await f.find('build'))!.permission), normalize(baselineBuild.permission));
        assert.deepEqual(normalize((await f.find('plan'))!.permission), normalize(baselinePlan.permission));
        const worker = await f.send('worker');
        assert.equal(worker.captured.model, 'beta');
        assert.match(JSON.stringify(worker.captured.messages), /NATIVE_WORKER/);
        for (const [name, marker] of [
          ['pinned', 'NATIVE_PINNED'],
          ['workflow', 'WORKFLOW_BODY'],
        ]) {
          const result = await f.send(name);
          assert.equal(result.captured.model, 'alpha', `${name} keeps its explicit model pin`);
          assert.match(JSON.stringify(result.captured.messages), new RegExp(marker));
        }
      },
    );

    await t.test(
      'disabled agents leave the native list, reject explicit requests and preserve their definitions',
      async () => {
        await f.select(['work', 'reduced']);
        for (const name of ['build', 'worker', 'pinned', 'workflow']) {
          assert.equal(await f.find(name), undefined, name);
          const session = await f.host.api<{ id: string }>('/session', { title: 'Disabled request' });
          const before = f.host.requests.length;
          const response = await f.host.response(`/session/${session.id}/message`, {
            agent: name,
            parts: [{ type: 'text', text: 'This disabled agent must not reach the provider.' }],
          });
          assert.equal(response.ok, false, `${name}: ${await response.text()}`);
          assert.equal(f.host.requests.length, before, 'disabled dispatch sends no provider request');
        }
        const config = await f.host.api<{
          agent: Record<string, { disable?: boolean; prompt?: string; model?: string }>;
        }>('/config');
        assert.equal(config.agent.workflow.disable, true);
        assert.equal(config.agent.workflow.prompt, 'WORKFLOW_BODY');
        assert.equal(config.agent.workflow.model, 'fixture/alpha');
        const fallback = await f.send();
        assert.equal(fallback.message.info.agent, 'plan', 'native fallback chooses the remaining visible primary');
        assert.equal(fallback.captured.model, 'beta');
        const continued = await f.send('plan', original.session.id);
        assert.equal(continued.message.info.agent, 'plan');
        assert.equal(continued.captured.model, 'beta');
        assert.ok(
          (await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id),
        );
      },
    );

    await t.test(
      'later enable decisions restore built-in and custom agents with their prompt and model pins',
      async () => {
        await f.select(['work', 'reduced', 'restored']);
        assert.deepEqual(normalize((await f.find('build'))!.permission), normalize(baselineBuild.permission));
        assert.equal((await f.send()).message.info.agent, 'build');
        assert.equal((await f.send('worker')).captured.model, 'beta');
        for (const [name, marker] of [
          ['workflow', 'WORKFLOW_BODY'],
          ['pinned', 'NATIVE_PINNED'],
          ['dormant', 'NATIVE_DORMANT'],
        ]) {
          const result = await f.send(name);
          assert.equal(result.captured.model, 'alpha');
          assert.match(JSON.stringify(result.captured.messages), new RegExp(marker));
        }
        assert.equal(await f.find('general'), undefined);
        assert.equal(await f.find('title'), undefined);
        assert.equal(await f.find('summary'), undefined);
      },
    );

    await t.test('invalid eligibility and internal toggles fail before writes or native changes', async () => {
      const before = await readFile(f.paths.shared, 'utf8');
      const list = await f.agents();
      for (const availability of [
        { build: false, plan: false, worker: false, pinned: false, workflow: false, dormant: false },
        { title: true },
        { summary: false },
        { compaction: true },
        { missing: true },
      ]) {
        await assert.rejects(
          f.saveDefinition({
            operation: 'patch',
            registry: 'profiles',
            name: 'restored',
            path: ['agentAvailability'],
            value: availability,
          }),
          /visible primary|internal|unavailable/,
        );
        assert.equal(await readFile(f.paths.shared, 'utf8'), before);
        assert.deepEqual(await f.agents(), list);
      }
      assert.equal((await f.send('worker')).captured.model, 'beta');
    });

    await t.test(
      'clearing profiles, repeated reload and restart retain session model selections and history',
      async () => {
        const selected = await f.send(
          'worker',
          undefined,
          { providerID: 'fixture', modelID: 'beta' },
          'SELECTED_HISTORY',
        );
        assert.equal(selected.captured.model, 'beta');
        await f.select([]);
        assert.equal((await f.send()).captured.model, 'alpha', 'new sessions return to the native model fallback');
        assert.equal((await f.send()).message.info.agent, 'build');
        assert.equal(await f.find('workflow'), undefined);
        for (const name of ['general', 'dormant', 'title', 'summary']) {
          assert.equal(await f.find(name), undefined, name);
        }
        for (let reload = 0; reload < 2; reload++) {
          await f.editor.reload();
          const continued = await f.send('worker', selected.session.id);
          assert.equal(continued.captured.model, 'beta', 'an existing session retains its explicit selected model');
          assert.match(JSON.stringify(continued.captured.messages), /SELECTED_HISTORY/);
        }
        await f.host.stop();
        await f.host.start();
        const restarted = await f.send('worker', selected.session.id);
        assert.equal(restarted.captured.model, 'beta');
        assert.match(JSON.stringify(restarted.captured.messages), /SELECTED_HISTORY/);
        assert.ok(
          (await f.history(selected.session.id)).some((message) => message.info.id === selected.message.info.id),
        );
        assert.equal((await f.send()).captured.model, 'alpha');
        assert.equal(await readFile(f.nativePath, 'utf8'), nativeBytes, 'Composer never rewrites native definitions');
        assert.match(await readFile(f.paths.shared, 'utf8'), /Preserve fixture comments/);
      },
    );
  },
);

test(
  'native explicit default remains authoritative and cannot be disabled by an availability edit',
  { timeout: 120_000 },
  async (t) => {
    const f = await availabilityFixture(t, 'availability-default', 'worker');
    await f.host.start();
    await f.select(['work']);
    assert.equal((await f.send()).message.info.agent, 'worker');
    const before = await readFile(f.paths.shared, 'utf8');
    await assert.rejects(
      f.saveDefinition({
        operation: 'patch',
        registry: 'profiles',
        name: 'work',
        path: ['agentAvailability'],
        value: { worker: false, workflow: true },
      }),
      /default_agent worker.*enabled.*visible.*primary/,
    );
    assert.equal(await readFile(f.paths.shared, 'utf8'), before);
    const config = await f.host.api<{ default_agent: string }>('/config');
    assert.equal(config.default_agent, 'worker');
    assert.equal((await f.send()).message.info.agent, 'worker');
    assert.equal((await f.send()).captured.model, 'beta');
  },
);
