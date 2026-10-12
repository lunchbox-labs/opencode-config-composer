import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { parseDocument } from 'yaml';
import { type AgentSettings, record } from '../src/config-composer/settings.ts';
import { parseCompositionDocument } from '../src/config-composer/composition/document.ts';
import { explainPermission, nativePermission } from '../src/config-composer/composition/permissions.ts';
import { resolveProfileRuntime } from '../src/config-composer/composition/runtime.ts';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';

async function example(t: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), 'composer-configuration-example-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL(`../docs/examples/${name}/`, import.meta.url), root, { recursive: true });
  const baseFile = join(root, 'config-composer.jsonc');
  const document = parseCompositionDocument(await readFile(baseFile, 'utf8'), baseFile);
  assert.equal(document.components, undefined, 'components are defined by OpenCode');
  return {
    root,
    select: async (activeProfiles: string[]) => {
      await writeFile(baseFile, JSON.stringify({ ...document, activeProfiles }));
      return loadCompositionSources({ root, baseFile, baseExplicit: true });
    },
  };
}

test('provider example switches the same built-in agents and clearing restores their original configuration', async (t) => {
  const f = await example(t, 'provider-profiles');
  const native = { model: 'example/base', agent: { build: { prompt: 'Build' }, plan: { prompt: 'Plan' } } };
  for (const [profile, model] of [
    ['anthropic', 'anthropic/claude-sonnet-4-5'],
    ['openai', 'openai/gpt-5'],
  ]) {
    const result = await resolveProfileRuntime(await f.select([profile]), native);
    assert.deepEqual(result.selectedAgents, ['build', 'plan', 'explore']);
    for (const name of result.selectedAgents) {
      assert.equal(result.agent[name].model, model);
    }
    assert.equal(result.agent.build.prompt, 'Build');
    assert.equal(result.agent.plan.prompt, 'Plan');
    assert.equal(result.model, native.model, 'agent profiles leave the workspace model unchanged');
    assert.deepEqual(result.permissionWarnings, []);
  }
  const cleared = await resolveProfileRuntime(await f.select([]), native);
  assert.deepEqual(cleared.agent, native.agent);
  assert.equal(cleared.model, native.model);
  const pinned = await resolveProfileRuntime(await f.select(['openai']), {
    ...native,
    agent: { ...native.agent, build: { ...native.agent.build, model: 'example/pinned' } },
  });
  assert.equal(pinned.agent.build.model, 'example/pinned');
});

test('role permission example shares developer rules while retaining distinct reviewer and orchestrator policies', async (t) => {
  const f = await example(t, 'role-permissions');
  const agents: Record<string, AgentSettings> = {};
  for (const file of await readdir(join(f.root, 'agents'))) {
    const text = await readFile(join(f.root, 'agents', file), 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(match !== null);
    const metadata: unknown = parseDocument(match[1]).toJS();
    assert.ok(record(metadata));
    assert.ok(metadata.mode === 'primary' || metadata.mode === 'subagent');
    assert.equal(typeof metadata.description, 'string');
    agents[basename(file, '.md')] = { ...metadata, prompt: text.slice(match[0].length).trim() };
  }
  const result = await resolveProfileRuntime(await f.select(['roles']), { agent: agents });
  assert.deepEqual(result.permissionWarnings, []);
  for (const [name, edit, git, npm] of [
    ['developer', 'allow', 'allow', 'allow'],
    ['test-writer', 'allow', 'allow', 'allow'],
    ['reviewer', 'deny', 'allow', 'deny'],
    ['orchestrator', 'deny', 'ask', 'ask'],
  ]) {
    const policy = nativePermission(result.agent[name].permission);
    assert.equal(explainPermission(policy, 'edit', 'src/app.ts').action, edit);
    assert.equal(explainPermission(policy, 'bash', 'git diff --stat').action, git);
    assert.equal(explainPermission(policy, 'bash', 'npm test').action, npm);
    assert.equal(explainPermission(policy, 'bash', 'other-command').action, 'ask');
    assert.equal(result.agent[name].prompt, agents[name].prompt);
    assert.equal(result.agent[name].model, undefined);
  }
  assert.equal(explainPermission(nativePermission(result.agent.orchestrator.permission), 'task', '*').action, 'allow');
  const cleared = await resolveProfileRuntime(await f.select([]), { agent: agents });
  assert.deepEqual(cleared.agent, agents);
});
