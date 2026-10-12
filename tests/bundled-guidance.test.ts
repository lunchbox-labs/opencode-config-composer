import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config as PluginConfig, PluginInput } from '@opencode-ai/plugin';
import type { Config } from '@opencode-ai/sdk/v2';
import server from '../src/server.ts';
import { bundledSkillDirectory, validateBundledSkills } from '../src/config-composer/bundled-skills.ts';
import { parseCompositionDocument } from '../src/config-composer/composition/document.ts';
import { loadCompositionSources } from '../src/config-composer/composition/sources.ts';
import { resolveProfileRuntime } from '../src/config-composer/composition/runtime.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-guidance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'composer.jsonc');
  await writeFile(file, '{}');
  return { root, file };
}

test('bundled guidance provides creation and explanation skills', async () => {
  assert.deepEqual((await readdir(bundledSkillDirectory)).sort(), [
    'config-composer-create',
    'config-composer-explain',
  ]);
  await validateBundledSkills();
});

test('bundled explanation guidance has a native skill identity and a packaged relative reference', async () => {
  await validateBundledSkills();
  const text = await readFile(join(bundledSkillDirectory, 'config-composer-explain/SKILL.md'), 'utf8');
  assert.match(text, /name: config-composer-explain/);
  assert.match(text, /description: Use when/);
  assert.match(text, /references\/schema.md/);
  assert.match(
    await readFile(join(bundledSkillDirectory, 'config-composer-explain/references/schema.md'), 'utf8'),
    /activeProfiles/,
  );
});

test('native registration retains paths and URLs, deduplicates bundled guidance, and leaves permissions intact', async (t) => {
  const f = await fixture(t);
  const hooks = await server.server({ directory: f.root, worktree: f.root } as PluginInput, { configFile: f.file });
  const config: Config = {
    skills: {
      paths: ['/native-skills', bundledSkillDirectory, '/native-skills'],
      urls: ['https://example.invalid/skills'],
    },
    permission: { skill: { '*': 'deny' } },
    agent: { worker: { prompt: 'Native body', permission: { skill: 'ask' } } },
  };
  const permissions = structuredClone({ global: config.permission, agent: config.agent!.worker!.permission });
  await hooks.config!(config as PluginConfig);
  await hooks.config!(config as PluginConfig);
  assert.deepEqual(config.skills, {
    paths: ['/native-skills', bundledSkillDirectory],
    urls: ['https://example.invalid/skills'],
  });
  assert.deepEqual({ global: config.permission, agent: config.agent!.worker!.permission }, permissions);
  assert.equal(config.agent!.worker!.prompt, 'Native body', 'native skills are not injected into agent prompts');
});

test('missing or misnamed bundled resources have an actionable installation diagnostic', async (t) => {
  const f = await fixture(t);
  await assert.rejects(validateBundledSkills(f.root), /bundled.*resource|reinstall/i);
  await mkdir(join(f.root, 'config-composer-explain/references'), { recursive: true });
  await writeFile(
    join(f.root, 'config-composer-explain/SKILL.md'),
    '---\nname: wrong\ndescription: Incorrect\n---\nBody',
  );
  await writeFile(join(f.root, 'config-composer-explain/references/schema.md'), 'Reference');
  await assert.rejects(validateBundledSkills(f.root), /identity|reinstall/i);
});

test('packaged creation example resolves native built-ins, mixed components, and a retained native model pin', async (t) => {
  const f = await fixture(t);
  const text = await readFile(join(bundledSkillDirectory, 'config-composer-create/examples/review.jsonc'), 'utf8');
  const value = parseCompositionDocument(text);
  assert.equal(value.activeProfiles, undefined, 'the reusable example does not activate itself');
  await writeFile(f.file, JSON.stringify({ ...value, activeProfiles: ['review'] }));
  const resolved = await resolveProfileRuntime(
    await loadCompositionSources({ root: f.root, baseFile: f.file, baseExplicit: true }),
    { model: 'fixture/default', agent: { plan: { model: 'fixture/pinned' } } },
  );
  assert.deepEqual(resolved.selectedAgents, ['plan', 'explore', 'reviewer']);
  assert.equal(resolved.agent.plan.model, 'fixture/pinned');
  assert.equal(resolved.agent.plan.prompt, undefined);
  assert.equal(resolved.agent.explore.prompt, undefined);
  const prompt = resolved.agent.reviewer.prompt;
  assert.ok(typeof prompt === 'string');
  assert.match(prompt, /Review the requested changes/);
  assert.equal(resolved.commands.review.agent, 'reviewer');
  assert.deepEqual(resolved.permissionWarnings, []);
});

test('bundled guidance remains available when settings fail or missing memberships are skipped', async (t) => {
  for (const value of [
    { unexpected: {} },
    {
      componentGroups: { work: { agents: ['missing'] } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    },
  ]) {
    const f = await fixture(t);
    await writeFile(f.file, JSON.stringify(value));
    const hooks = await server.server({ directory: f.root, worktree: f.root } as PluginInput, { configFile: f.file });
    const config: Config = {
      model: 'fixture/native',
      agent: { worker: { prompt: 'Native body' } },
      skills: { paths: ['/native-skills'] },
    };
    if ('unexpected' in value) {
      await assert.rejects(hooks.config!(config as PluginConfig), /must NOT have additional properties/);
    } else {
      await hooks.config!(config as PluginConfig);
    }
    assert.equal(config.model, 'fixture/native');
    assert.deepEqual(config.agent, { worker: { prompt: 'Native body' } });
    assert.deepEqual(config.command ?? {}, {});
    assert.deepEqual(config.skills?.paths, ['/native-skills', bundledSkillDirectory]);
  }
});
