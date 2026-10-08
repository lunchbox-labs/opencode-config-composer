import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { nativeHarness } from './integration/harness.ts';
import { installedEditor } from './integration/editor.ts';

const example = new URL('../docs/examples/review-programming/', import.meta.url);
const reviewScope =
  'Keep review findings grounded in the current change. Describe the evidence, likely impact, and a practical correction.';
const programmingScope =
  'Keep changes focused on the requested behavior. Follow existing conventions and report verification results.';
const agents = {
  'code-reviewer': {
    description: 'Review changes for correctness and maintainability',
    prompt:
      'Review the current changes. Identify concrete bugs, explain their impact, and cite the relevant files and lines.',
    scope: reviewScope,
  },
  'test-auditor': {
    description: 'Audit test coverage and verification gaps',
    prompt:
      'Compare the requested behavior with existing tests. Identify missing cases and distinguish verified behavior from assumptions.',
    scope: reviewScope,
  },
  implementer: {
    description: 'Implement the requested change',
    prompt:
      "Implement the requested change using the repository's existing conventions. Explain the resulting behavior and any remaining limitations.",
    scope: programmingScope,
  },
  'test-writer': {
    description: 'Add focused tests for the requested behavior',
    prompt:
      'Add tests that exercise the requested behavior, including meaningful failure and boundary cases. Report the checks you actually ran.',
    scope: programmingScope,
  },
};
const commands = {
  'review-code': {
    agent: 'code-reviewer',
    description: 'Review the current diff',
    template:
      'Review the current diff for correctness and maintainability. Explain concrete findings with file references.',
  },
  'audit-tests': {
    agent: 'test-auditor',
    description: 'Audit coverage of the current change',
    template: 'Audit the tests for the current change. Identify important behavior that is not exercised.',
  },
  implement: {
    agent: 'implementer',
    description: 'Implement the requested change',
    template: 'Implement the requested change: $ARGUMENTS',
  },
  'write-tests': {
    agent: 'test-writer',
    description: 'Add tests for the requested behavior',
    template: 'Add focused tests for the requested behavior: $ARGUMENTS',
  },
};

interface NativeAgent {
  name: string;
  description: string;
  prompt: string;
  mode: string;
  model?: { providerID: string; modelID: string };
  permission: { permission: string; pattern: string; action: string }[];
}

for (const layout of ['project', 'global'] as const) {
  test(`review/programming example loads native Markdown in the ${layout} layout`, { timeout: 240_000 }, async (t) => {
    const host = await nativeHarness(t, `review-programming-${layout}`);
    await mkdir(join(host.project, '.opencode'), { recursive: true });
    const directory = layout === 'project' ? join(host.project, '.opencode') : host.configRoot;
    await cp(example, directory, { recursive: true });
    // Use the actual packed package instead of the documented installation placeholder.
    for (const filename of ['opencode.jsonc', 'tui.jsonc']) {
      const content = await readFile(join(directory, filename), 'utf8');
      await writeFile(
        join(directory, filename),
        content.replace(
          '@lunchbox-labs/opencode-config-composer@VERSION',
          JSON.stringify(host.installed.directory).slice(1, -1),
        ),
      );
    }
    if (layout === 'project') {
      // The Composer editor reads its server registration from the global installation directory.
      await writeFile(
        join(host.configRoot, 'opencode.jsonc'),
        JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: [host.installed.directory] }),
      );
    }
    await host.start();
    const { snapshot } = await installedEditor(host);
    assert.deepEqual((await snapshot()).sources.activeProfiles, ['claude-coding']);
    for (const profile of ['claude-coding', 'openai-coding']) {
      // Project-local selection is the final scope, even for a global installation.
      await writeFile(
        join(host.project, '.opencode/config-composer.local.jsonc'),
        JSON.stringify({ activeProfiles: [profile] }),
      );
      await host.api('/instance/dispose', {}, 'POST');
      const running = await host.api<NativeAgent[]>('/agent');
      const saved = await snapshot();
      for (const [name, expected] of Object.entries(agents)) {
        const actual = running.find((agent) => agent.name === name);
        assert.ok(actual !== undefined, `native agent ${name} is registered`);
        assert.equal(actual.description, expected.description);
        assert.equal(actual.mode, 'subagent');
        assert.equal(actual.prompt, `${expected.prompt}\n\n${expected.scope}`);
        assert.deepEqual(actual.model, {
          providerID: profile === 'claude-coding' ? 'anthropic' : 'openai',
          modelID: profile === 'claude-coding' ? 'claude-sonnet-4-5' : 'gpt-5',
        });
        assert.equal(saved.resolved.choices[name].parameters?.maxOutputTokens, 4096);
        const review = name === 'code-reviewer' || name === 'test-auditor';
        const action = (pattern: string) =>
          actual.permission.findLast((rule) => rule.permission === 'bash' && rule.pattern === pattern)?.action;
        assert.equal(
          action('git *'),
          review && !(name === 'code-reviewer' && profile === 'claude-coding') ? 'ask' : 'allow',
        );
        assert.equal(action('npm *'), review ? 'deny' : 'ask');
      }
      const nativeCommands =
        await host.api<{ name: string; agent: string; description: string; template: string; subtask: boolean }[]>(
          '/command',
        );
      for (const [name, expected] of Object.entries(commands)) {
        const actual = nativeCommands.find((command) => command.name === name);
        assert.ok(actual !== undefined, `native command ${name} is registered`);
        assert.equal(actual.agent, expected.agent);
        assert.equal(actual.description, expected.description);
        assert.equal(actual.template, expected.template);
        assert.equal(actual.subtask, true);
      }
      const skills = await host.api<{ name: string }[]>('/skill');
      for (const name of ['code-review', 'test-audit', 'implementation', 'test-writing']) {
        assert.ok(
          skills.some((skill) => skill.name === name),
          `native skill ${name} is available`,
        );
      }
      const config = await host.api<{ model: string; small_model: string; default_agent: string }>('/config');
      const authored = parse(await readFile(join(directory, 'opencode.jsonc'), 'utf8')) as typeof config;
      assert.equal(config.model, authored.model);
      assert.equal(config.small_model, authored.small_model);
      assert.equal(config.default_agent, authored.default_agent);
    }
    await writeFile(join(host.project, '.opencode/config-composer.local.jsonc'), '{"activeProfiles":[]}');
    await host.api('/instance/dispose', {}, 'POST');
    const nativeOnly = await host.api<NativeAgent[]>('/agent');
    for (const [name, expected] of Object.entries(agents)) {
      const actual = nativeOnly.find((agent) => agent.name === name);
      assert.ok(actual !== undefined);
      assert.equal(actual.prompt, `${expected.prompt}\n\n${expected.scope}`);
      assert.equal(actual.model, undefined, 'clearing profiles restores native model inheritance');
      assert.equal((await snapshot()).resolved.choices[name], undefined);
    }
    const nativeCommands = await host.api<{ name: string }[]>('/command');
    assert.ok(Object.keys(commands).every((name) => nativeCommands.some((command) => command.name === name)));
    assert.equal(host.requests.length, 0, 'configuration inspection makes no provider requests');
  });
}
