import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSnapshot,
  memberships,
  planChange,
  plannedChoices,
  reloadConfiguration,
  savePlan,
} from '../src/config-composer/storage.ts';
import { nativeAncestorPaths } from '../src/config-composer/composition/native-sources.ts';
import { packageName } from '../src/config-composer/package-name.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-project-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installation = join(root, 'config');
  const project = join(root, 'project');
  const directory = join(project, 'packages/app');
  await mkdir(installation);
  await mkdir(join(project, '.opencode/agents'), { recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(installation, 'opencode.jsonc'),
    JSON.stringify({ plugin: [packageName], model: 'fixture/native' }),
  );
  await writeFile(
    join(installation, 'config-composer.jsonc'),
    JSON.stringify({
      componentGroups: {
        work: { agents: ['build', 'project-json', 'project-md'], configuration: { model: 'fixture/group' } },
        secondary: {},
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  await writeFile(
    join(project, 'opencode.jsonc'),
    JSON.stringify({ agent: { 'project-json': { description: 'Native JSON agent', model: 'fixture/pinned' } } }),
  );
  await writeFile(
    join(project, '.opencode/agents/project-md.md'),
    '---\ndescription: Native Markdown agent\ngroups: [secondary]\n---\nKeep this native prompt.',
  );
  return { root, installation, project, directory };
}

test('existing project JSON and Markdown agents join JSONC groups without shadow definitions or pin changes', async (t) => {
  const f = await fixture(t);
  const markdown = join(f.project, '.opencode/agents/project-md.md');
  const original = await readFile(markdown, 'utf8');
  const snapshot = await loadSnapshot(f.installation, f.project);
  assert.equal(snapshot.resolved.agent['project-json'].model, 'fixture/pinned');
  assert.equal(snapshot.resolved.agent['project-md'].model, 'fixture/group');
  const agent = snapshot.agents.find((agent) => agent.name === 'project-md')!;
  assert.deepEqual(memberships(snapshot, agent), ['secondary', 'work']);
  const plan = planChange(snapshot, { kind: 'membership', agent: agent.name, groups: ['secondary', 'new-group'] });
  assert.deepEqual(
    plan.edits.map((edit) => edit.file.path),
    [snapshot.settingsFile.path],
  );
  await savePlan(plan);
  const updated = await loadSnapshot(f.installation, f.project);
  assert.deepEqual(
    memberships(
      updated,
      updated.agents.find((item) => item.name === agent.name)!,
    ),
    ['secondary', 'new-group'],
  );
  assert.equal(await readFile(markdown, 'utf8'), original);
  assert.equal((updated.config.agent as Record<string, unknown> | undefined)?.['project-md'], undefined);
  assert.throws(() => planChange(updated, { kind: 'membership', agent: agent.name, groups: [] }), /native frontmatter/);
});

test('project-native sources and new native agents participate in stale-save detection', async (t) => {
  const f = await fixture(t);
  const snapshot = await loadSnapshot(f.installation, f.project);
  const plan = planChange(snapshot, { kind: 'group', name: 'work', choice: { model: 'fixture/next' } });
  const choices = await plannedChoices(plan);
  assert.ok(choices.some((choice) => choice.model === 'fixture/next'));
  const path = join(f.project, '.opencode/agents/project-md.md');
  await writeFile(path, (await readFile(path, 'utf8')) + '\nConcurrent project edit');
  await assert.rejects(savePlan(plan), /Settings changed/);
  const fresh = planChange(await loadSnapshot(f.installation, f.project), {
    kind: 'group',
    name: 'work',
    choice: { model: 'fixture/next' },
  });
  await writeFile(join(f.project, '.opencode/agents/new.md'), '---\ndescription: Newly discovered\n---\nPrompt');
  await assert.rejects(savePlan(fresh), /agent list changed/);
});

test('read-only native aliases retain their native identity and detect retargeting', async (t) => {
  const f = await fixture(t);
  const alias = join(f.project, '.opencode/agents/project-md.md');
  const original = await readFile(alias, 'utf8');
  const target = join(f.root, 'shared.md');
  const other = join(f.root, 'other.md');
  await writeFile(target, original);
  await writeFile(other, original);
  await rm(alias);
  await symlink(target, alias);
  const snapshot = await loadSnapshot(f.installation, f.project);
  const plan = planChange(snapshot, { kind: 'group', name: 'work', choice: { model: 'fixture/next' } });
  await rm(alias);
  await symlink(other, alias);
  await assert.rejects(savePlan(plan), /identity changed/);
});

test('native project precedence follows root JSON, descendant JSON, global Markdown, then nearest-to-root directories', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.installation, 'agents'));
  await writeFile(
    join(f.installation, 'agents/project-json.md'),
    '---\nmodel: fixture/global-markdown\n---\nGlobal body',
  );
  await writeFile(
    join(f.directory, 'opencode.jsonc'),
    JSON.stringify({ agent: { 'project-json': { model: 'fixture/descendant-json' } } }),
  );
  await mkdir(join(f.directory, '.opencode/agent'), { recursive: true });
  await writeFile(
    join(f.directory, '.opencode/agent/project-md.md'),
    '---\nmodel: fixture/descendant-markdown\n---\nDescendant body',
  );
  let snapshot = await loadSnapshot(f.installation, f.project, undefined, f.directory);
  assert.equal(snapshot.nativeAgents['project-json'].model, 'fixture/global-markdown');
  assert.equal(snapshot.nativeAgents['project-md'].model, 'fixture/descendant-markdown');
  assert.equal(snapshot.nativeAgents['project-md'].prompt, 'Keep this native prompt.');
  await writeFile(
    join(f.project, '.opencode/opencode.jsonc'),
    JSON.stringify({ agent: { 'project-json': { model: 'fixture/project-directory' } } }),
  );
  snapshot = await loadSnapshot(f.installation, f.project, undefined, f.directory);
  assert.equal(snapshot.nativeAgents['project-json'].model, 'fixture/project-directory');
  await savePlan(planChange(snapshot, { kind: 'group', name: 'work', choice: { model: 'fixture/changed' } }));
  assert.equal(
    (await loadSnapshot(f.installation, f.project, undefined, f.directory)).nativeAgents['project-json'].model,
    'fixture/project-directory',
  );
});

test('native project frontmatter name overrides are discoverable and disabled agents cannot be selected', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.project, '.opencode/agents/alias.md'),
    '---\nname: renamed\ndescription: Native alias\n---\nPrompt',
  );
  const snapshot = await loadSnapshot(f.installation, f.project);
  assert.ok(snapshot.agents.some((agent) => agent.name === 'renamed'));
  assert.ok(!snapshot.agents.some((agent) => agent.name === 'alias'));
  await writeFile(join(f.project, '.opencode/agents/project-md.md'), '---\ndisable: true\n---\nDisabled');
  await assert.rejects(loadSnapshot(f.installation, f.project), /disabled/);
});

test('duplicate native Markdown identities require one unambiguous directory definition', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, '.opencode/agent'));
  await writeFile(
    join(f.project, '.opencode/agent/project-md.md'),
    '---\nmodel: fixture/discarded\ngroups: [missing]\n---\nEarlier body',
  );
  await assert.rejects(
    loadSnapshot(f.installation, f.project),
    /Duplicate native agent identity.*project-md.*Keep one definition/,
  );
});

test('a native worktree root remains independent from the project composition scope outside Git', async (t) => {
  const f = await fixture(t);
  const snapshot = await loadSnapshot(f.installation, f.directory, undefined, f.directory, '/');
  assert.equal(snapshot.sourceContext.root, f.directory);
  assert.equal(snapshot.nativeAgents['project-json'].model, 'fixture/pinned');
  assert.ok(snapshot.agents.some((agent) => agent.name === 'project-md'));
});

test('new project-native files block reload before the host update', async (t) => {
  const f = await fixture(t);
  const snapshot = await loadSnapshot(f.installation, f.project);
  await writeFile(join(f.project, '.opencode/agents/new.md'), '---\ngroups: [work]\n---\nNew group member');
  let updates = 0;
  await assert.rejects(
    reloadConfiguration(snapshot, async () => {
      updates++;
    }),
    /source list changed/,
  );
  assert.equal(updates, 0);
});

test('native JSONC environment and file substitutions resolve effective pins while preserving authored bytes', async (t) => {
  const f = await fixture(t);
  const variable = 'COMPOSER_TEST_NATIVE_MODEL';
  const originalEnv = process.env[variable];
  process.env[variable] = 'fixture/pinned';
  t.after(() => {
    if (originalEnv === undefined) {
      Reflect.deleteProperty(process.env, variable);
    } else {
      process.env[variable] = originalEnv;
    }
  });
  const path = join(f.project, 'opencode.jsonc');
  const text =
    '{"agent":{"project-json":{"model":"{env:COMPOSER_TEST_NATIVE_MODEL}","prompt":"{file:./native-prompt.txt}"}}}\n// {file:./missing-comment.txt}\n';
  await writeFile(path, text);
  await writeFile(join(f.project, 'native-prompt.txt'), '  Native "quoted" prompt\nsecond line  \n');
  const snapshot = await loadSnapshot(f.installation, f.project);
  assert.equal(snapshot.nativeAgents['project-json'].model, 'fixture/pinned');
  assert.equal(snapshot.nativeAgents['project-json'].prompt, 'Native "quoted" prompt\nsecond line');
  const plan = planChange(snapshot, { kind: 'group', name: 'work', choice: { model: 'fixture/changed' } });
  await savePlan(plan);
  assert.equal((await loadSnapshot(f.installation, f.project)).resolved.agent['project-json'].model, 'fixture/pinned');
  assert.equal(await readFile(path, 'utf8'), text);
});

test('native substitution environment and file changes invalidate an open save or reload', async (t) => {
  const f = await fixture(t);
  const variable = 'COMPOSER_TEST_STALE_NATIVE_MODEL';
  const originalEnv = process.env[variable];
  process.env[variable] = 'fixture/pinned';
  t.after(() => {
    if (originalEnv === undefined) {
      Reflect.deleteProperty(process.env, variable);
    } else {
      process.env[variable] = originalEnv;
    }
  });
  await writeFile(
    join(f.project, 'opencode.jsonc'),
    '{"agent":{"project-json":{"model":"{env:COMPOSER_TEST_STALE_NATIVE_MODEL}","prompt":"{file:./native-prompt.txt}"}}}',
  );
  const prompt = join(f.project, 'native-prompt.txt');
  await writeFile(prompt, 'Native prompt');
  const snapshot = await loadSnapshot(f.installation, f.project);
  process.env[variable] = 'fixture/other';
  await assert.rejects(
    savePlan(planChange(snapshot, { kind: 'group', name: 'work', choice: { model: 'fixture/changed' } })),
    /substitution|environment|changed/i,
  );
  const fresh = await loadSnapshot(f.installation, f.project);
  await writeFile(prompt, 'Changed prompt');
  let updates = 0;
  await assert.rejects(
    reloadConfiguration(fresh, async () => {
      updates++;
    }),
    /changed/i,
  );
  assert.equal(updates, 0);
});

test('native non-Git discovery interprets the slash sentinel on the project drive or UNC share', () => {
  assert.deepEqual(nativeAncestorPaths('/', 'D:\\work\\project', win32), ['D:\\work\\project', 'D:\\work', 'D:\\']);
  assert.deepEqual(nativeAncestorPaths('/', '\\\\server\\share\\project', win32), [
    '\\\\server\\share\\project',
    '\\\\server\\share\\',
  ]);
  assert.deepEqual(nativeAncestorPaths('/', '/work/project', posix), ['/work/project', '/work', '/']);
  assert.deepEqual(nativeAncestorPaths('C:\\repo', 'C:\\repo\\..nested', win32), ['C:\\repo\\..nested', 'C:\\repo']);
  for (const directory of ['D:\\project', 'C:\\repo-other', '\\\\server\\other\\project']) {
    assert.throws(() => nativeAncestorPaths('C:\\repo', directory, win32), /inside its worktree/);
  }
  assert.throws(
    () => nativeAncestorPaths('/', '/' + Array.from({ length: 65 }, () => 'nested').join('/'), posix),
    /64 directories/,
  );
});
