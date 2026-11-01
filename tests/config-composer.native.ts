import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { actionOnlyPermissions, permissionNames } from '../src/config-composer/host.ts';
import { compositionFixture } from './integration/composition-fixture.ts';
test(
  'installed native authority preserves field pins and appends authored permission rules last',
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
        '---\ngroups: [all]\nmodel: fixture/beta\nvariant: high\ntemperature: 0\ntop_p: 0\noptions: { flag: false }\npermission: deny\n---\nOPAQUE_WORKER_BODY',
      empty: '---\ngroups: [all]\nmodel: ""\nvariant: ""\noptions: {}\npermission: {}\n---\nOPAQUE_EMPTY_BODY',
      scalar: '---\npermission: deny\n---\nOPAQUE_SCALAR_BODY',
      tools: '---\ntools: { bash: false, read: true }\n---\nOPAQUE_TOOLS_BODY',
    };
    for (const [name, body] of Object.entries(bodies)) {
      await writeFile(join(f.host.configRoot, 'agents', `${name}.md`), body);
    }
    await writeFile(
      join(f.host.configRoot, 'modes/legacy.md'),
      '---\ngroups: [all]\nmode: subagent\n---\nOPAQUE_MODE_BODY',
    );
    await writeFile(join(f.host.configRoot, 'modes/omitted.md'), '---\ngroups: [all]\n---\nOPAQUE_MODE_BODY');
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
      groups: { all: { agent: patch } },
      agent: { worker: patch, empty: patch, legacy: { mode: 'subagent' }, omitted: { mode: 'subagent' } },
      profiles: { review: { groups: { all: { agent: patch } }, agent: { worker: patch, empty: patch } } },
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
    assert.deepEqual(config.agent.worker.permission, { read: 'allow', '*': 'deny' });
    assert.equal((await f.editor.runtime()).observation.authority.worker.fields.model?.value, 'fixture/beta');
    assert.equal(config.agent.empty.model, '');
    assert.equal(config.agent.empty.variant, '');
    assert.deepEqual(config.agent.empty.options, {});
    assert.deepEqual(config.agent.empty.permission, { '*': 'allow', read: 'allow' });
    assert.equal(config.agent.legacy.mode, 'primary');
    assert.equal(config.agent.omitted.mode, 'subagent');
    assert.deepEqual(config.agent.scalar.permission, { '*': 'deny' });
    assert.deepEqual(config.agent.tools.permission, { bash: 'deny', read: 'allow' });
    const agents = await f.host.api<{ name: string; model?: { modelID: string }; permission: unknown[] }[]>('/agent');
    assert.equal(agents.find((agent) => agent.name === 'worker')?.model?.modelID, 'beta');
    assert.ok(
      agents.find((agent) => agent.name === 'empty')!.permission.length > 0,
      'empty authored permission maps retain composed and native rules',
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

test(
  'invalid Composer permission and mode values leave native endpoints readable and publish errors',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'invalid-native-values');
    const documents = [
      ...[...actionOnlyPermissions].flatMap((tool) =>
        [{}, { '*': 'deny' }].map((value) => ({
          model: 'fixture/beta',
          agent: { worker: { temperature: 0.9, permission: { [tool]: value } } },
        })),
      ),
      {
        groups: { bad: { agent: { permission: { webfetch: {} } } } },
      },
      ...[['primary'], ['subagent'], ['all'], [[['primary']]]].map((mode) => ({
        agent: { worker: { model: 'fixture/beta' } },
        profiles: { inactive: { agent: { worker: { mode } } } },
      })),
    ];
    const nativeBytes = await readFile(f.paths.native, 'utf8');
    for (const [index, document] of documents.entries()) {
      await f.write(f.paths.shared, document);
      if (index === 0) {
        await f.host.start();
      } else {
        await f.host.stop();
        await f.host.start();
      }
      const config = await f.host.api<{ model: string; agent: Record<string, Record<string, unknown>> }>('/config');
      assert.equal(config.model, f.native.model);
      assert.equal(config.agent.worker.model, undefined);
      assert.equal(config.agent.worker.temperature, undefined);
      assert.equal(config.agent.worker.mode, 'primary');
      await assert.rejects(f.editor.runtime(), /Composer not applied.*Expected/);
      const agents = await f.host.api<{ name: string; mode: string }[]>('/agent');
      assert.equal(agents.find((agent) => agent.name === 'worker')?.mode, 'primary');
    }
    assert.equal(await readFile(f.paths.native, 'utf8'), nativeBytes);
    await f.write(f.paths.shared, {});
    await f.host.api('/instance/dispose', {});
    await assert.rejects(f.editor.runtime(), /Composer not applied.*Expected/);
    await f.host.stop();
    await f.host.start();
    assert.equal((await f.editor.runtime()).status, 'applied');
  },
);

test(
  'native validation rejects pattern blocks for exactly the action-only permissions',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'native-action-only-permissions');
    const permission = Object.fromEntries([...permissionNames, 'custom_tool'].map((name) => [name, { '*': 'deny' }]));
    await f.host.start({ configContent: { agent: { worker: { permission } } } });
    const response = await f.host.response('/config');
    const body = (await response.json()) as { name?: string; data?: { issues?: { path: string[] }[] } };
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.name, 'ConfigInvalidError');
    assert.deepEqual(
      new Set(body.data?.issues?.map(({ path }) => path.join('.'))),
      new Set([...actionOnlyPermissions].map((name) => `agent.worker.permission.${name}`)),
    );
  },
);

test(
  'native agent membership order combines permission patterns and never reaches provider options',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'native-membership-order');
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        ...f.native.agent,
        worker: { ...f.native.agent.worker, groups: ['first', 'last'], options: { retained: false } },
        helper: { ...f.native.agent.helper, groups: ['first', 'last'] },
      },
    });
    await mkdir(join(f.host.configRoot, 'agents'));
    const helperBody = '---\ngroups: [last, first]\n---\nHELPER_BODY';
    const pinnedBody =
      '---\ngroups: [first, last]\nmodel: fixture/alpha\ntemperature: 0\noptions: { retained: false }\npermission: deny\n---\nPINNED_BODY';
    await writeFile(join(f.host.configRoot, 'agents/helper.md'), helperBody);
    await writeFile(join(f.host.configRoot, 'agents/pinned.md'), pinnedBody);
    const firstPolicy = { bash: { '*': 'ask', 'git *': 'allow' } };
    const lastPolicy = { bash: { 'git *': 'deny' } };
    await f.write(f.paths.shared, {
      groups: {
        last: { agent: { temperature: 0.2, permission: lastPolicy } },
        first: { agent: { model: 'fixture/alpha', temperature: 0.1, permission: firstPolicy } },
      },
      profiles: {
        a: { groups: { first: { agent: { model: 'fixture/beta', temperature: 0.9 } } } },
        b: { groups: { first: { agent: { temperature: 0.7 } } } },
      },
    });
    const nativeBytes = await readFile(f.paths.native);
    await f.host.start();
    for (const choice of ['a', 'b', 'a', null] as const) {
      await f.editor.applySelection(await f.editor.select(choice));
      const config = await f.host.api<{ agent: Record<string, Record<string, unknown>> }>('/config');
      assert.equal(config.agent.worker.temperature, 0.2, 'later shared group wins over an earlier profile patch');
      assert.equal(config.agent.helper.temperature, choice === 'a' ? 0.9 : choice === 'b' ? 0.7 : 0.1);
      assert.deepEqual(config.agent.worker.permission, { bash: { '*': 'ask', 'git *': 'deny' } });
      assert.deepEqual(config.agent.helper.permission, firstPolicy);
      assert.equal(config.agent.pinned.temperature, 0);
      assert.equal(config.agent.pinned.model, 'fixture/alpha');
      assert.deepEqual(config.agent.pinned.permission, { bash: { '*': 'ask', 'git *': 'deny' }, '*': 'deny' });
      assert.deepEqual(config.agent.worker.options, { retained: false });
      assert.deepEqual(config.agent.pinned.options, { retained: false });
      for (const name of ['worker', 'helper', 'pinned']) {
        assert.equal(config.agent[name].groups, undefined, name);
        assert.equal((config.agent[name].options as Record<string, unknown>).groups, undefined, name);
      }
      const agents = await f.host.api<{ name: string; options: Record<string, unknown> }[]>('/agent');
      for (const name of ['worker', 'helper', 'pinned']) {
        assert.equal(agents.find((agent) => agent.name === name)?.options.groups, undefined, name);
      }
    }
    const sent = await f.send('worker');
    assert.equal(sent.captured.model, 'alpha');
    assert.equal(await readFile(join(f.host.configRoot, 'agents/helper.md'), 'utf8'), helperBody);
    assert.equal(await readFile(join(f.host.configRoot, 'agents/pinned.md'), 'utf8'), pinnedBody);
    assert.deepEqual(await readFile(f.paths.native), nativeBytes);
  },
);

test(
  'native bootstrap failures strip membership metadata without claiming application',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'native-membership-failure');
    const cases = [
      { groups: ['known'], document: { groups: { known: {} }, invalid: true }, diagnostic: /Unknown key/ },
      { groups: ['missing'], document: { groups: { known: {} } }, diagnostic: /unknown group/ },
      { groups: 'known', document: { groups: { known: {} } }, diagnostic: /array/i },
    ];
    for (const [index, scenario] of cases.entries()) {
      if (index > 0) {
        await f.host.stop();
      }
      await f.write(f.paths.native, {
        ...f.native,
        agent: {
          ...f.native.agent,
          worker: {
            ...f.native.agent.worker,
            groups: scenario.groups,
            model: 'fixture/alpha',
            temperature: 0,
            options: { retained: false },
            permission: { edit: 'deny' },
          },
        },
      });
      await f.write(f.paths.shared, scenario.document);
      const nativeBytes = await readFile(f.paths.native);
      const sharedBytes = await readFile(f.paths.shared);
      await f.host.start();
      const config = await f.host.api<{
        agent: Record<string, Record<string, unknown>>;
        plugin: [string, { __configComposerRuntime?: { status: string; revision?: unknown; diagnostic: string } }][];
      }>('/config');
      assert.equal(config.agent.worker.groups, undefined);
      assert.deepEqual(config.agent.worker.options, { retained: false });
      assert.equal(config.agent.worker.model, 'fixture/alpha');
      assert.equal(config.agent.worker.temperature, 0);
      assert.deepEqual(config.agent.worker.permission, { edit: 'deny' });
      const marker = config.plugin.find(([, options]) => options.__configComposerRuntime !== undefined)?.[1]
        .__configComposerRuntime;
      assert.ok(marker !== undefined);
      assert.equal(marker.status, 'error');
      assert.equal(marker.revision, undefined);
      assert.match(marker.diagnostic, scenario.diagnostic);
      const agents = await f.host.api<{ name: string; options: Record<string, unknown> }[]>('/agent');
      assert.equal(agents.find((agent) => agent.name === 'worker')?.options.groups, undefined);
      assert.deepEqual(await readFile(f.paths.native), nativeBytes);
      assert.deepEqual(await readFile(f.paths.shared), sharedBytes);
    }
  },
);
