import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';
test(
  'installed native authority preserves actual pins above every Composer layer and later JSON',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'native-authority');
    await mkdir(join(f.host.configRoot, 'agents'));
    await mkdir(join(f.host.configRoot, 'modes'));
    await mkdir(join(f.host.project, '.opencode/agents'), { recursive: true });
    const laterMarkdown = '---\noptions: { last: false }\npermission: {}\n---\nOPAQUE_LATER_BODY';
    await writeFile(join(f.host.project, '.opencode/agents/worker.md'), laterMarkdown);
    const bodies = {
      worker:
        '---\nmodel: fixture/beta\nvariant: high\ntemperature: 0\ntop_p: 0\noptions: { flag: false }\npermission: deny\n---\nOPAQUE_WORKER_BODY',
      empty: '---\nmodel: ""\nvariant: ""\noptions: {}\npermission: {}\n---\nOPAQUE_EMPTY_BODY',
      scalar: '---\npermission: deny\n---\nOPAQUE_SCALAR_BODY',
      tools: '---\ntools: { bash: false, read: true }\n---\nOPAQUE_TOOLS_BODY',
    };
    for (const [name, body] of Object.entries(bodies)) {
      await writeFile(join(f.host.configRoot, 'agents', `${name}.md`), body);
    }
    await writeFile(join(f.host.configRoot, 'modes/legacy.md'), '---\nmode: subagent\n---\nOPAQUE_MODE_BODY');
    await writeFile(join(f.host.configRoot, 'modes/omitted.md'), '---\n---\nOPAQUE_MODE_BODY');
    await writeFile(
      join(f.host.project, 'opencode.jsonc'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        agent: {
          worker: { model: 'fixture/alpha', temperature: 1, options: { later: true }, permission: 'allow' },
          empty: { model: 'fixture/alpha', variant: 'high', options: { later: true }, permission: 'allow' },
        },
      }),
    );
    const patch = {
      model: 'fixture/alpha',
      variant: 'high',
      temperature: 1,
      top_p: 1,
      options: { composer: true },
      permission: { read: 'allow' },
    };
    await f.write(f.paths.shared, {
      groups: [{ name: 'all', members: { agent: ['worker', 'empty', 'legacy', 'omitted'] }, agent: patch }],
      agent: { worker: patch, empty: patch, legacy: { mode: 'subagent' }, omitted: { mode: 'subagent' } },
      profiles: { review: { groups: [{ name: 'all', agent: patch }], agent: { worker: patch, empty: patch } } },
      defaultProfile: 'review',
    });
    const nativeBytes = await readFile(f.paths.native, 'utf8');
    const projectBytes = await readFile(join(f.host.project, 'opencode.jsonc'), 'utf8');
    await f.host.start();
    const config = await f.host.api<{ agent: Record<string, Record<string, unknown>> }>('/config');
    assert.equal(config.agent.worker.model, 'fixture/beta');
    assert.equal(config.agent.worker.temperature, 0);
    assert.equal(config.agent.worker.top_p, 0);
    assert.deepEqual(config.agent.worker.options, { last: false });
    assert.deepEqual(config.agent.worker.permission, {});
    assert.equal((await f.editor.runtime()).observation.authority.worker.fields.model?.value, 'fixture/beta');
    assert.equal(config.agent.empty.model, '');
    assert.equal(config.agent.empty.variant, '');
    assert.deepEqual(config.agent.empty.options, {});
    assert.deepEqual(config.agent.empty.permission, {});
    assert.equal(config.agent.legacy.mode, 'primary');
    assert.equal(config.agent.omitted.mode, 'subagent');
    assert.deepEqual(config.agent.scalar.permission, { '*': 'deny' });
    assert.deepEqual(config.agent.tools.permission, { bash: 'deny', read: 'allow' });
    const agents = await f.host.api<{ name: string; model?: { modelID: string }; permission: unknown[] }[]>('/agent');
    assert.equal(agents.find((agent) => agent.name === 'worker')?.model?.modelID, 'beta');
    assert.ok(
      agents.find((agent) => agent.name === 'empty')!.permission.length > 0,
      'native /agent inherits builtin/global policies after an empty final config policy',
    );
    const runtime = await f.editor.runtime();
    const decision = runtime.candidate!.decisions['/agent/worker/model'];
    assert.equal(decision.value, 'fixture/beta');
    assert.match(decision.origin.source!, /worker\.md$/);
    assert.equal(decision.blockedComposer?.value, 'fixture/alpha');
    assert.doesNotMatch(JSON.stringify(runtime), /OPAQUE_.*BODY/);
    assert.equal((await f.send()).captured.model, 'beta');
    for (const [name, body] of Object.entries(bodies)) {
      assert.equal(await readFile(join(f.host.configRoot, 'agents', `${name}.md`), 'utf8'), body);
    }
    assert.equal(await readFile(join(f.host.project, '.opencode/agents/worker.md'), 'utf8'), laterMarkdown);
    assert.equal(await readFile(f.paths.native, 'utf8'), nativeBytes);
    assert.equal(await readFile(join(f.host.project, 'opencode.jsonc'), 'utf8'), projectBytes);
  },
);
