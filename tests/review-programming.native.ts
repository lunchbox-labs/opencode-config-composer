import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseConfiguration } from '../src/config-composer/configuration.ts';
import { compositionFixture } from './integration/composition-fixture.ts';
test(
  'shipped review example applies to native builtin targets and packaged help loads',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'shipped-review');
    await f.write(
      f.paths.shared,
      parseConfiguration(
        await readFile(new URL('../docs/examples/review-programming/config-composer.jsonc', import.meta.url), 'utf8'),
      ),
    );
    const exampleNative = parseConfiguration(
      await readFile(new URL('../docs/examples/review-programming/opencode.jsonc', import.meta.url), 'utf8'),
    );
    await f.write(f.paths.native, { ...f.native, agent: { ...f.native.agent, ...(exampleNative.agent as object) } });
    await f.host.start();
    await f.editor.applySelection(await f.editor.select('review'));
    const config = await f.host.api<{ agent: { plan: { temperature: number }; explore: { temperature: number } } }>(
      '/config',
    );
    assert.equal(config.agent.plan.temperature, 0);
    assert.equal(config.agent.explore.temperature, 0);
    const skills = await f.host.api<{ name: string }[]>('/skill');
    assert.ok(skills.some((skill) => skill.name === 'config-composer-explain'));
    assert.equal(f.host.requests.length, 0);
  },
);

test('all shipped examples select and reset settings on existing native agents', { timeout: 240000 }, async (t) => {
  const f = await compositionFixture(t, 'shipped-examples');
  type Expected = Record<string, Record<string, unknown>>;
  const reviewPermission = { bash: { 'git *': 'ask', 'npm *': 'deny' } };
  const programmingPermission = { bash: { 'git *': 'allow', 'npm *': 'ask' } };
  const examples: {
    path: string;
    defaultProfile?: string;
    shared: Expected;
    profiles: Record<string, Expected>;
  }[] = [
    {
      path: '../docs/examples/provider-profiles/config-composer.jsonc',
      defaultProfile: 'anthropic',
      shared: { build: { model: undefined }, plan: { model: undefined }, explore: { model: undefined } },
      profiles: {
        anthropic: {
          build: { model: 'anthropic/claude-sonnet-4-5' },
          plan: { model: 'anthropic/claude-sonnet-4-5' },
          explore: { model: 'anthropic/claude-sonnet-4-5' },
        },
        openai: {
          build: { model: 'openai/gpt-5' },
          plan: { model: 'openai/gpt-5' },
          explore: { model: 'openai/gpt-5' },
        },
        mixed: {
          build: { model: 'openai/gpt-5' },
          plan: { model: 'anthropic/claude-sonnet-4-5' },
          explore: { model: 'anthropic/claude-sonnet-4-5' },
        },
      },
    },
    {
      path: '../docs/examples/project-selection/config-composer.jsonc',
      defaultProfile: 'development',
      shared: { build: { temperature: undefined }, plan: { temperature: undefined } },
      profiles: {
        development: { build: { temperature: 0.2 }, plan: { temperature: 0.2 } },
        review: {
          build: { temperature: 0, permission: { edit: 'ask' } },
          plan: { temperature: 0, permission: { edit: 'ask' } },
        },
      },
    },
    {
      path: '../docs/examples/role-permissions/config-composer.jsonc',
      shared: {
        plan: { permission: reviewPermission },
        explore: { permission: reviewPermission },
        build: { permission: programmingPermission },
        general: { permission: programmingPermission },
      },
      profiles: {
        cautious: {
          plan: { permission: reviewPermission },
          build: { permission: { bash: { 'git *': 'allow', 'npm *': 'ask', '*': 'ask' } } },
          general: { permission: { bash: { 'git *': 'allow', 'npm *': 'ask', '*': 'ask' } } },
        },
      },
    },
    {
      path: '../docs/examples/review-programming/config-composer.jsonc',
      defaultProfile: 'review',
      shared: {
        plan: { temperature: undefined, permission: reviewPermission },
        build: { temperature: undefined, permission: programmingPermission },
      },
      profiles: {
        review: { plan: { temperature: 0 }, explore: { temperature: 0 }, build: { temperature: undefined } },
        programming: { build: { temperature: 0.2 }, general: { temperature: 0.2 }, plan: { temperature: undefined } },
      },
    },
    {
      path: '../skills/config-composer-create/examples/review.jsonc',
      shared: { plan: { temperature: undefined, permission: { bash: { 'git *': 'ask' } } } },
      profiles: { review: { plan: { temperature: 0 }, explore: { temperature: 0 } } },
    },
  ];

  await f.host.start();
  const nativeNames = new Set((await f.host.api<{ name: string }[]>('/agent')).map((agent) => agent.name));
  for (const example of examples) {
    await f.editor.applySelection(await f.editor.select(null));
    const text = await readFile(new URL(example.path, import.meta.url), 'utf8');
    parseConfiguration(text);
    await writeFile(f.paths.shared, text);
    const exampleNative = parseConfiguration(
      await readFile(new URL('opencode.jsonc', new URL(example.path, import.meta.url)), 'utf8'),
    );
    await f.write(f.paths.native, { ...f.native, agent: { ...f.native.agent, ...(exampleNative.agent as object) } });
    const nativeBytes = await readFile(f.paths.native);
    await f.host.stop();
    await f.host.start();
    for (const choice of [undefined, ...Object.keys(example.profiles), null]) {
      await f.editor.applySelection(await f.editor.select(choice));
      const selected = choice === undefined ? (example.defaultProfile ?? null) : choice;
      assert.equal((await f.editor.runtime()).candidate?.profile, selected);
      const expected = selected === null ? example.shared : example.profiles[selected];
      const config = await f.host.api<{
        agent: Record<string, Record<string, unknown>>;
        command: Record<string, Record<string, unknown>>;
      }>('/config');
      for (const [name, fields] of Object.entries(expected)) {
        assert.ok(nativeNames.has(name), `${name} must already be a native target`);
        for (const [field, value] of Object.entries(fields)) {
          assert.deepEqual(config.agent[name][field], value, `${example.path} / ${String(choice)} / ${name}.${field}`);
        }
      }
      assert.equal(config.agent.worker.prompt, 'NATIVE_WORKER');
      assert.equal(config.command.review.template, 'NATIVE_REVIEW $ARGUMENTS');
      await f.host.api('/agent');
      assert.equal(await readFile(f.paths.shared, 'utf8'), text);
      assert.deepEqual(await readFile(f.paths.native), nativeBytes);
    }
  }
  assert.equal(f.host.requests.length, 0, 'illustrative provider allocations must not send model requests');
});
