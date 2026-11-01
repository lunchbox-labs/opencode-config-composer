import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';
import {
  type PermissionAction,
  type PermissionAgent,
  installSkill,
  nativeSkill,
} from './integration/permission-fixture.ts';

function matches(pattern: string, value: string): boolean {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.')}$`,
    's',
  ).test(value);
}
function action(agents: PermissionAgent[], name: string, tool: string, pattern: string): PermissionAction {
  const agent = agents.find((item) => item.name === name);
  assert.ok(agent !== undefined, `native agent ${name}`);
  return (
    agent.permission.findLast((rule) => matches(rule.permission, tool) && matches(rule.pattern, pattern))?.action ??
    'ask'
  );
}

test(
  'native permissions compose every layer and profile defaults reset without reloading edited definitions',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'permission-combination-layers');
    await installSkill(f.host);
    const globalPermission = {
      read: 'ask',
      edit: 'deny',
      task: { '*': 'deny', 'global-only': 'allow' },
      skill: { '*': 'deny', 'included-skill': 'deny' },
    };
    await f.write(f.paths.native, {
      ...f.native,
      permission: globalPermission,
      agent: {
        ...f.native.agent,
        worker: {
          ...f.native.agent.worker,
          groups: ['first', 'last'],
          permission: {
            task: {
              'native-only': 'allow',
              profile: 'allow',
              shared: 'deny',
              paired: 'deny',
              late: 'deny',
              named: 'deny',
              'profile-named': 'deny',
              frontmatter: 'deny',
            },
          },
        },
        helper: {
          ...f.native.agent.helper,
          permission: { skill: { 'included-skill': 'deny' }, task: { profile: 'allow' } },
        },
      },
    });
    const document = {
      defaultProfile: 'a',
      groups: {
        first: { agent: { permission: { task: { shared: 'allow', paired: 'allow', late: 'allow' } } } },
        last: {
          agent: {
            permission: { task: { late: 'allow', named: 'deny', 'profile-named': 'deny', frontmatter: 'deny' } },
          },
        },
      },
      agent: { worker: { permission: { task: { named: 'allow', 'profile-named': 'deny', frontmatter: 'deny' } } } },
      profiles: {
        a: {
          permission: {
            edit: 'ask',
            task: { profile: 'deny', 'profile-only': 'allow' },
            skill: { 'included-skill': 'ask' },
          },
          groups: { first: { agent: { permission: { task: { paired: 'deny', late: 'deny' } } } } },
          agent: { worker: { permission: { task: { 'profile-named': 'allow', frontmatter: 'deny' } } } },
        },
        b: {
          permission: {
            edit: 'allow',
            task: { profile: 'ask', 'profile-only': 'deny' },
            skill: { 'included-skill': 'deny' },
          },
        },
      },
    };
    await f.write(f.paths.shared, document);
    await mkdir(join(f.host.configRoot, 'agents'));
    const frontmatter =
      '---\nmode: primary\npermission:\n  task:\n    frontmatter: ask\n  skill:\n    included-skill: allow\n---\nNATIVE_WORKER_BODY';
    await writeFile(join(f.host.configRoot, 'agents/worker.md'), frontmatter);
    await writeFile(
      join(f.host.configRoot, 'agents/empty.md'),
      '---\nmode: subagent\npermission: {}\n---\nEMPTY_PIN_BODY',
    );
    const nativeBytes = await readFile(f.paths.native, 'utf8');
    await f.host.start();
    const loaded = await f.editor.runtime();
    assert.equal(loaded.status, 'applied');
    assert.equal(loaded.candidate?.profile, 'a');

    // Composer definitions stay captured while live selection changes.
    const edited = structuredClone(document);
    edited.profiles.a.permission.skill['included-skill'] = 'deny';
    await f.write(f.paths.shared, edited);
    for (const choice of ['a', 'b', 'a', null] as const) {
      await f.editor.applySelection(await f.editor.select(choice));
      const runtime = await f.editor.runtime();
      assert.equal(runtime.definitionId, loaded.definitionId);
      const agents = await f.host.api<PermissionAgent[]>('/agent');
      // Every agent the host reports, including built-ins Composer did not see in native config.
      for (const { name } of agents) {
        assert.equal(
          action(agents, name, 'edit', 'file.ts'),
          choice === 'a' ? 'ask' : choice === 'b' ? 'allow' : 'deny',
          `${name}: profile-wide permissions`,
        );
        assert.equal(
          action(agents, name, 'read', 'file.ts'),
          'ask',
          `${name}: absent keys retain native global fallback`,
        );
      }
      assert.equal(action(agents, 'worker', 'task', 'global-only'), 'allow');
      assert.equal(action(agents, 'worker', 'task', 'native-only'), 'allow');
      assert.equal(
        action(agents, 'worker', 'task', 'profile'),
        choice === 'a' ? 'deny' : choice === 'b' ? 'ask' : 'allow',
      );
      assert.equal(action(agents, 'worker', 'task', 'profile-only'), choice === 'a' ? 'allow' : 'deny');
      assert.equal(action(agents, 'worker', 'task', 'shared'), 'allow');
      assert.equal(action(agents, 'worker', 'task', 'paired'), choice === 'a' ? 'deny' : 'allow');
      assert.equal(
        action(agents, 'worker', 'task', 'late'),
        'allow',
        'later shared group overrides earlier profile group',
      );
      assert.equal(action(agents, 'worker', 'task', 'named'), 'allow');
      assert.equal(action(agents, 'worker', 'task', 'profile-named'), choice === 'a' ? 'allow' : 'deny');
      assert.equal(action(agents, 'worker', 'task', 'frontmatter'), 'ask');
      assert.equal(
        action(agents, 'helper', 'task', 'profile'),
        choice === 'a' ? 'deny' : choice === 'b' ? 'ask' : 'allow',
        'profile defaults override native JSON agent policy',
      );
      const skill = choice === 'a' ? 'ask' : 'deny';
      await nativeSkill(f.host, 'helper', skill);
      await nativeSkill(f.host, 'worker', 'allow');
      assert.equal(action(agents, 'empty', 'skill', 'included-skill'), skill, 'empty frontmatter adds no rules');
      const config = await f.host.api<{ permission: unknown }>('/config');
      assert.deepEqual(
        config.permission,
        globalPermission,
        'Composer never writes the global native permission policy',
      );
      assert.equal(await readFile(f.paths.native, 'utf8'), nativeBytes);
      assert.equal(await readFile(join(f.host.configRoot, 'agents/worker.md'), 'utf8'), frontmatter);
    }

    await f.editor.applySelection(await f.editor.select('a'));
    await f.host.stop();
    await f.host.start();
    const restarted = await f.editor.runtime();
    assert.equal(restarted.candidate?.profile, 'a');
    assert.notEqual(restarted.definitionId, loaded.definitionId);
    await nativeSkill(f.host, 'helper', 'deny');
    await nativeSkill(f.host, 'worker', 'allow');
  },
);

test(
  'native rule order follows moved tool blocks, additive patterns and exact duplicate reinsertion',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'permission-combination-order');
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        ...f.native.agent,
        worker: { ...f.native.agent.worker, groups: ['first', 'all', 'last'] },
        overlap: { mode: 'subagent', groups: ['patterns', 'patterns-later'] },
        scalar: { mode: 'subagent', groups: ['scalar', 'last'] },
        scalarLast: { mode: 'subagent', groups: ['scalar', 'last', 'scalar-last'] },
        globs: { mode: 'subagent', groups: ['glob-first', 'glob-middle', 'glob-last'] },
      },
    });
    await f.write(f.paths.shared, {
      groups: {
        first: { agent: { permission: { task: { alpha: 'allow' } } } },
        all: { agent: { permission: 'deny' } },
        last: { agent: { permission: { task: { beta: 'allow' } } } },
        patterns: { agent: { permission: { task: { '*': 'deny', 'alpha*': 'allow', alphabet: 'deny' } } } },
        'patterns-later': { agent: { permission: { task: { alpha: 'deny', '*': 'ask', alphabet: 'allow' } } } },
        scalar: { agent: { permission: { task: 'deny' } } },
        'scalar-last': { agent: { permission: { task: 'ask' } } },
        'glob-first': { agent: { permission: { 'a*': { x: 'allow' } } } },
        'glob-middle': { agent: { permission: { '*b': 'deny' } } },
        'glob-last': { agent: { permission: { 'a*': { y: 'allow' } } } },
      },
    });
    await f.host.start();
    const runtime = await f.editor.runtime();
    assert.equal(runtime.status, 'applied');
    const candidate = runtime.candidate!;
    assert.deepEqual(Object.keys(candidate.agent.worker.permission as object), ['*', 'task']);
    assert.deepEqual(candidate.agent.worker.permission, { '*': 'deny', task: { alpha: 'allow', beta: 'allow' } });
    const agents = await f.host.api<PermissionAgent[]>('/agent');
    assert.equal(action(agents, 'worker', 'task', 'alpha'), 'allow', 'retained alpha moves with the later task block');
    assert.equal(action(agents, 'worker', 'task', 'beta'), 'allow');
    assert.equal(action(agents, 'worker', 'task', 'gamma'), 'deny');
    assert.deepEqual(
      agents
        .find((agent) => agent.name === 'worker')!
        .permission.filter((rule) => rule.permission === '*' || rule.permission === 'task')
        .slice(-3),
      [
        { permission: '*', pattern: '*', action: 'deny' },
        { permission: 'task', pattern: 'alpha', action: 'allow' },
        { permission: 'task', pattern: 'beta', action: 'allow' },
      ],
    );
    assert.deepEqual(
      agents.find((agent) => agent.name === 'overlap')!.permission.filter((rule) => rule.permission === 'task'),
      [
        { permission: 'task', pattern: 'alpha*', action: 'allow' },
        { permission: 'task', pattern: 'alpha', action: 'deny' },
        { permission: 'task', pattern: '*', action: 'ask' },
        { permission: 'task', pattern: 'alphabet', action: 'allow' },
      ],
    );
    assert.equal(action(agents, 'overlap', 'task', 'alphax'), 'ask');
    assert.equal(action(agents, 'overlap', 'task', 'alphabet'), 'allow');
    assert.equal(action(agents, 'scalar', 'task', 'alpha'), 'deny');
    assert.equal(action(agents, 'scalar', 'task', 'beta'), 'allow');
    assert.equal(action(agents, 'scalarLast', 'task', 'beta'), 'ask');
    assert.deepEqual(
      agents.find((agent) => agent.name === 'scalarLast')!.permission.filter((rule) => rule.permission === 'task'),
      [
        { permission: 'task', pattern: 'beta', action: 'allow' },
        { permission: 'task', pattern: '*', action: 'ask' },
      ],
    );
    assert.equal(action(agents, 'globs', 'ab', 'x'), 'allow');
    assert.equal(action(agents, 'globs', 'ab', 'y'), 'allow');
    assert.equal(action(agents, 'globs', 'zb', 'x'), 'deny');
    const config = await f.host.api<{ agent: { worker: { permission: Record<string, unknown> } } }>('/config');
    t.diagnostic(
      `Native /config permission keys: ${JSON.stringify(Object.keys(config.agent.worker.permission))}; applied /agent order: ["*","task/alpha","task/beta"]`,
    );
    await f.editor.storage.previewSelection(await f.editor.context(), null);
  },
);
