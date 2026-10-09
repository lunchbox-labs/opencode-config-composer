import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyEdits, modify } from 'jsonc-parser';
import type * as Baseline from '../src/config-composer/composition/runtime-baseline.ts';
import { installedEditor } from './integration/editor.ts';
import { nativeHarness } from './integration/harness.ts';
import type { NativePermissionRule } from './native-bundled-permissions.ts';

const reviewScope =
  'Keep review findings grounded in the current change. Describe the evidence, likely impact, and a practical correction.';
const programmingScope =
  'Keep changes focused on the requested behavior. Follow existing conventions and report verification results.';
const expectedAgents = {
  'code-reviewer': {
    description: 'Review changes for correctness and maintainability',
    body: 'Review the current changes. Identify concrete bugs, explain their impact, and cite the relevant files and lines.',
    scope: reviewScope,
  },
  'test-auditor': {
    description: 'Audit test coverage and verification gaps',
    body: 'Compare the requested behavior with existing tests. Identify missing cases and distinguish verified behavior from assumptions.',
    scope: reviewScope,
  },
  implementer: {
    description: 'Implement the requested change',
    body: "Implement the requested change using the repository's existing conventions. Explain the resulting behavior and any remaining limitations.",
    scope: programmingScope,
  },
  'test-writer': {
    description: 'Add focused tests for the requested behavior',
    body: 'Add tests that exercise the requested behavior, including meaningful failure and boundary cases. Report the checks you actually ran.',
    scope: programmingScope,
  },
};
const expectedCommands = {
  'review-code': {
    description: 'Review the current diff',
    agent: 'code-reviewer',
    template:
      'Review the current diff for correctness and maintainability. Explain concrete findings with file references.',
  },
  'audit-tests': {
    description: 'Audit coverage of the current change',
    agent: 'test-auditor',
    template: 'Audit the tests for the current change. Identify important behavior that is not exercised.',
  },
  implement: {
    description: 'Implement the requested change',
    agent: 'implementer',
    template: 'Implement the requested change: $ARGUMENTS',
  },
  'write-tests': {
    description: 'Add tests for the requested behavior',
    agent: 'test-writer',
    template: 'Add focused tests for the requested behavior: $ARGUMENTS',
  },
};
const expectedSkills = {
  'code-review': 'Review a code change for concrete correctness and maintainability issues.',
  'test-audit': "Compare a change's intended behavior with its existing test coverage.",
  implementation: "Implement a requested behavior using the repository's existing conventions.",
  'test-writing': 'Add focused tests that verify a requested behavior and its important boundaries.',
};
interface NativeAgent {
  name: string;
  description?: string;
  mode: string;
  prompt?: string;
  model?: { providerID: string; modelID: string };
  permission: NativePermissionRule[];
}
interface NativeCommand {
  name: string;
  description?: string;
  agent?: string;
  subtask?: boolean;
  template: string;
}
const nativeGlobals = {
  model: 'anthropic/claude-sonnet-4-5',
  small_model: 'openai/gpt-5',
  default_agent: 'build',
};

for (const scope of ['shared', 'project'] as const) {
  test(
    `shipped review/programming workflow composes native files in ${scope} scope`,
    { timeout: 300_000 },
    async (t) => {
      const host = await nativeHarness(t, `review-programming-${scope}`);
      const destination = scope === 'shared' ? host.configRoot : join(host.project, '.opencode');
      await mkdir(destination, { recursive: true });
      await cp(fileURLToPath(new URL('../docs/examples/review-programming/', import.meta.url)), destination, {
        recursive: true,
      });
      const placeholder = JSON.stringify('@lunchbox-labs/opencode-config-composer@VERSION');
      for (const name of ['opencode.jsonc', 'tui.jsonc']) {
        const path = join(destination, name);
        const text = await readFile(path, 'utf8');
        assert.equal(text.split(placeholder).length, 2, `${name} contains one release placeholder`);
        await writeFile(path, text.replace(placeholder, JSON.stringify(host.installed.directory)));
      }
      const nativeFiles = [
        'opencode.jsonc',
        'tui.jsonc',
        ...Object.keys(expectedAgents).map((name) => `agents/${name}.md`),
        ...Object.keys(expectedCommands).map((name) => `commands/${name}.md`),
        ...Object.keys(expectedSkills).map((name) => `skills/${name}/SKILL.md`),
      ];
      const before = await Promise.all(nativeFiles.map((name) => readFile(join(destination, name), 'utf8')));
      await host.start();
      const editor = await installedEditor(host);
      const { readRuntimeChoices } = (await import(
        pathToFileURL(join(host.installed.directory, 'dist/config-composer/composition/runtime-baseline.js')).href
      )) as typeof Baseline;
      const globalBefore = await host.api('/global/config');
      const assertWorkflow = async (profile: 'claude-coding' | 'openai-coding' | undefined) => {
        const [agents, commands, skills, config] = await Promise.all([
          host.api<NativeAgent[]>('/agent'),
          host.api<NativeCommand[]>('/command'),
          host.api<{ name: string; description: string; location: string }[]>('/skill'),
          host.api<typeof nativeGlobals>('/config'),
        ]);
        for (const [key, value] of Object.entries(nativeGlobals)) {
          assert.equal(config[key as keyof typeof nativeGlobals], value, `${key} remains a native global default`);
        }
        const { location } = await editor.runtime();
        const { choices } = readRuntimeChoices(config, location, host.configRoot);
        for (const [name, expected] of Object.entries(expectedAgents)) {
          assert.equal(agents.filter((agent) => agent.name === name).length, 1, name);
          const agent = agents.find((agent) => agent.name === name);
          assert.ok(agent !== undefined, name);
          assert.equal(agent.description, expected.description);
          assert.equal(agent.mode, 'subagent');
          assert.equal(agent.prompt, profile === undefined ? expected.body : `${expected.body}\n\n${expected.scope}`);
          const choice = Object.entries(choices).find(([key]) => key === name)?.[1];
          if (profile === undefined) {
            assert.equal(agent.model, undefined, 'native agent inherits the unchanged global model');
            assert.equal(choice?.parameters?.maxOutputTokens, undefined);
          } else {
            const model = profile === 'claude-coding' ? 'anthropic/claude-sonnet-4-5' : 'openai/gpt-5';
            const [providerID, modelID] = model.split('/');
            assert.deepEqual(agent.model, { providerID, modelID });
            assert.ok(choice !== undefined, 'selected native agent has a running Composer choice');
            assert.equal(choice.model, model);
            assert.equal(choice.parameters?.maxOutputTokens, 4096, 'running Composer dispatch limit');
          }
          // Native rules are ordered; these examples use only * and the two literal command-prefix patterns.
          const bashAction = (prefix: 'git' | 'npm') =>
            agent.permission.findLast(
              (rule) =>
                (rule.permission === '*' || rule.permission === 'bash') &&
                (rule.pattern === '*' || rule.pattern === `${prefix} *`),
            )?.action;
          const review = name === 'code-reviewer' || name === 'test-auditor';
          assert.equal(
            bashAction('git'),
            profile === undefined || !review || (profile === 'claude-coding' && name === 'code-reviewer')
              ? 'allow'
              : 'ask',
          );
          assert.equal(bashAction('npm'), profile === undefined ? 'allow' : review ? 'deny' : 'ask');
        }
        for (const [name, expected] of Object.entries(expectedCommands)) {
          const command = commands.find((item) => item.name === name);
          assert.ok(command !== undefined, name);
          assert.deepEqual(
            {
              description: command.description,
              agent: command.agent,
              template: command.template,
              subtask: command.subtask,
            },
            { ...expected, subtask: true },
          );
        }
        for (const [name, description] of Object.entries(expectedSkills)) {
          const skill = skills.find((item) => item.name === name);
          assert.ok(skill !== undefined, name);
          assert.equal(skill.description, description);
          assert.equal(skill.location, join(destination, 'skills', name, 'SKILL.md'));
        }
        assert.deepEqual(await host.api('/global/config'), globalBefore, 'composition preserves native global inputs');
        assert.equal(host.requests.length, 0, 'registry checks do not dispatch a model request');
      };
      await assertWorkflow('claude-coding');
      const composerPath = join(destination, 'config-composer.jsonc');
      for (const profile of ['openai-coding', undefined] as const) {
        const text = await readFile(composerPath, 'utf8');
        await writeFile(
          composerPath,
          applyEdits(text, modify(text, ['activeProfiles'], profile === undefined ? [] : [profile], {})),
        );
        assert.equal(await host.api('/instance/dispose', {}), true);
        await assertWorkflow(profile);
      }
      assert.deepEqual(
        await Promise.all(nativeFiles.map((name) => readFile(join(destination, name), 'utf8'))),
        before,
        'profile changes preserve every native agent, command, skill, and host configuration file',
      );
    },
  );
}
