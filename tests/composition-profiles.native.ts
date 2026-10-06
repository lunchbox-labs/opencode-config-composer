import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeHarness } from './integration/harness.ts';
import type * as Runtime from '../src/config-composer/composition/runtime.ts';

// The native registry is the oracle: neither config debug output nor a copied built-in prompt is used.
test(
  'activated profiles overlay native built-ins and imported custom agents without shadow declarations',
  { timeout: 180_000 },
  async (t) => {
    const host = await nativeHarness(t, 'canonical-native-registry');
    const { root, configRoot, project, installed } = host;
    const { nativeAgentNames } = (await import(
      pathToFileURL(join(installed.directory, 'dist/config-composer/composition/runtime.js')).href
    )) as typeof Runtime;
    await mkdir(join(project, '.opencode'), { recursive: true });
    await mkdir(join(root, 'library/checks'), { recursive: true });
    await writeFile(
      join(root, 'library/reviewer.md'),
      '---\ndescription: Synthetic reviewer\nmode: subagent\ngroups: [work]\npermission:\n  edit: deny\n---\nNative custom body.',
    );
    await writeFile(
      join(root, 'library/checks/SKILL.md'),
      '---\nname: checks\ndescription: Synthetic checks\n---\nOn-demand native skill.',
    );
    await writeFile(
      join(root, 'library/definitions.jsonc'),
      JSON.stringify({
        components: {
          agents: { reviewer: { file: './reviewer.md' } },
          skills: { checks: { file: './checks/SKILL.md' } },
          commands: { review: { template: 'Review $ARGUMENTS', agent: 'reviewer' } },
        },
        componentGroups: {
          work: {
            agents: [...nativeAgentNames],
            commands: ['review'],
            skills: ['checks'],
            configuration: { model: 'fixture/alpha' },
          },
          later: { agents: ['build'], configuration: { model: 'fixture/beta' } },
        },
        profiles: {
          base: { layers: [{ componentGroup: 'work' }] },
          work: { extends: 'base', layers: [{ componentGroup: 'later' }] },
        },
      }),
    );
    await writeFile(
      join(configRoot, 'config-composer.jsonc'),
      JSON.stringify({ imports: [join(root, 'library/definitions.jsonc')], activeProfiles: [] }),
    );
    await writeFile(
      join(configRoot, 'opencode.json'),
      JSON.stringify({
        plugin: [installed.directory],
        model: 'fixture/alpha',
        enabled_providers: [],
        agent: { plan: { model: 'fixture/pinned' } },
      }),
    );
    await host.start();
    const api = <T>(path: string, method = 'GET') => host.api<T>(path, undefined, method);
    interface Agent {
      name: string;
      native: boolean;
      prompt?: string | null;
      mode: string;
      hidden?: boolean | null;
      permission: { permission: string; pattern: string; action: string }[];
      options: Record<string, unknown>;
      model?: { providerID: string; modelID: string };
    }
    const baseline = await api<Agent[]>('/agent');
    assert.deepEqual(
      baseline
        .filter((item) => item.native)
        .map((item) => item.name)
        .sort(),
      [...nativeAgentNames].sort(),
      'verify the complete pinned native identity catalog',
    );
    assert.ok(!baseline.some((item) => item.name === 'reviewer'), 'definitions alone do not activate custom agents');
    const local = join(project, '.opencode/config-composer.local.jsonc');
    await writeFile(local, '{"activeProfiles":["work"]}');
    await api('/instance/dispose', 'POST');
    const activated = await api<Agent[]>('/agent');
    for (const before of baseline.filter((item) => item.native)) {
      const after = activated.find((item) => item.name === before.name);
      assert.ok(after !== undefined, before.name);
      assert.equal(after.native, true);
      assert.equal(after.prompt ?? undefined, before.prompt ?? undefined, `preserve ${before.name} native prompt`);
      assert.equal(after.mode, before.mode);
      assert.equal(after.hidden ?? undefined, before.hidden ?? undefined);
      // OpenCode itself grants access to configured native skill directories.
      const skillRule = {
        permission: 'external_directory',
        pattern: `${join(root, 'library/checks')}/*`,
        action: 'allow',
      };
      assert.ok(after.permission.some((rule) => JSON.stringify(rule) === JSON.stringify(skillRule)));
      assert.deepEqual(
        after.permission.filter((rule) => rule.pattern !== skillRule.pattern),
        before.permission,
      );
      assert.deepEqual(after.model, {
        providerID: 'fixture',
        modelID: before.name === 'plan' ? 'pinned' : before.name === 'build' ? 'beta' : 'alpha',
      });
    }
    const reviewer = activated.find((item) => item.name === 'reviewer');
    assert.ok(reviewer !== undefined);
    assert.equal(reviewer.mode, 'subagent');
    assert.equal(reviewer.prompt, 'Native custom body.');
    assert.deepEqual(reviewer.model, { providerID: 'fixture', modelID: 'alpha' });
    assert.deepEqual(reviewer.options.groups, ['work']);
    const commands = await api<{ name: string; agent?: string }[]>('/command');
    assert.equal(commands.find((item) => item.name === 'review')?.agent, 'reviewer');
    const skills = await api<{ name: string; location: string }[]>('/skill');
    assert.ok(skills.some((item) => item.name === 'checks' && item.location === join(root, 'library/checks/SKILL.md')));
    await writeFile(local, '{"activeProfiles":[]}');
    await api('/instance/dispose', 'POST');
    const cleared = await api<Agent[]>('/agent');
    assert.deepEqual(cleared, baseline, 'empty local selection restores the exact native registry');
  },
);
