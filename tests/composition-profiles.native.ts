import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeHarness } from './integration/harness.ts';
import { installedEditor } from './integration/editor.ts';
import { bundledPermissions } from './integration/bundled-permissions.ts';
import type * as Storage from '../src/config-composer/storage.ts';
import type * as Baseline from '../src/config-composer/composition/runtime-baseline.ts';
import type * as Activation from '../src/config-composer/composition/activation.ts';
import type * as Authoring from '../src/config-composer/composition/authoring.ts';
import type * as Runtime from '../src/config-composer/composition/runtime.ts';

// The native registry is the oracle: neither config debug output nor a copied built-in prompt is used.
test(
  'activated profiles overlay native built-ins and imported custom agents without shadow declarations',
  { timeout: 300_000 },
  async (t) => {
    const host = await nativeHarness(t, 'canonical-native-registry');
    const { root, configRoot, project, installed } = host;
    const { snapshot, runtime } = await installedEditor(host);
    const { nativeAgentNames } = (await import(
      pathToFileURL(join(installed.directory, 'dist/config-composer/composition/runtime.js')).href
    )) as typeof Runtime;
    await mkdir(join(project, '.opencode'), { recursive: true });
    await mkdir(join(root, 'library/checks'), { recursive: true });
    const { planChange, savePlan, saveFilePlan, previewFilePlan, reloadConfiguration } = (await import(
      pathToFileURL(join(installed.directory, 'dist/config-composer/storage.js')).href
    )) as typeof Storage;
    const { planDefinition, previewDefinition } = (await import(
      pathToFileURL(join(installed.directory, 'dist/config-composer/composition/authoring.js')).href
    )) as typeof Authoring;
    const { readRuntimeBaseline } = (await import(
      pathToFileURL(join(installed.directory, 'dist/config-composer/composition/runtime-baseline.js')).href
    )) as typeof Baseline;
    const previousModel = process.env.COMPOSER_FIXTURE_AGENT_MODEL;
    process.env.COMPOSER_FIXTURE_AGENT_MODEL = 'fixture/project-pin';
    t.after(() => {
      if (previousModel === undefined) {
        Reflect.deleteProperty(process.env, 'COMPOSER_FIXTURE_AGENT_MODEL');
      } else {
        process.env.COMPOSER_FIXTURE_AGENT_MODEL = previousModel;
      }
    });
    await writeFile(join(project, 'native-agent-prompt.txt'), 'Native project JSON body.\n');
    const { planScope } = (await import(
      pathToFileURL(join(installed.directory, 'dist/config-composer/composition/activation.js')).href
    )) as typeof Activation;
    const activate = async (profiles?: string[]) => {
      const plan = planScope(await snapshot(), 'local', {
        operation: 'selection',
        profiles,
      });
      await saveFilePlan(plan, async () => {
        await previewFilePlan(plan);
      });
    };
    const projectJson = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      agent: {
        'project-json': { model: '{env:COMPOSER_FIXTURE_AGENT_MODEL}', prompt: '{file:./native-agent-prompt.txt}' },
      },
    });
    const projectMarkdown =
      '---\ndescription: Existing project agent\ngroups: [work]\n---\nNative project Markdown body.';
    await writeFile(join(project, 'opencode.jsonc'), projectJson);
    await mkdir(join(project, '.opencode/agent'));
    await writeFile(
      join(project, '.opencode/agent/project-md.md'),
      '---\nmodel: fixture/discarded\n---\nObsolete duplicate body.',
    );
    await mkdir(join(root, '.opencode/agents'), { recursive: true });
    await writeFile(
      join(root, '.opencode/agents/ancestor.md'),
      '---\ndescription: Ancestor agent outside Git\n---\nAncestor body.',
    );
    await mkdir(join(project, '.opencode/agents'));
    await writeFile(join(project, '.opencode/agents/project-md.md'), projectMarkdown);
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
        configurationPresets: { 'native-model': { modelRef: 'opencode:model' } },
        componentGroups: {
          'native-preview': { agents: ['build'] },
          work: {
            agents: [...nativeAgentNames, 'project-json', 'project-md', 'ancestor'],
            commands: ['review'],
            skills: ['checks'],
            configuration: { model: 'fixture/alpha' },
          },
          later: { agents: ['build'], configuration: { model: 'fixture/beta' } },
        },
        profiles: {
          base: { layers: [{ componentGroup: 'work' }] },
          work: { extends: 'base', layers: [{ componentGroup: 'later' }] },
          'global-parent': { overrides: { model: 'fixture/composer' } },
        },
      }),
    );
    await writeFile(
      join(configRoot, 'config-composer.jsonc'),
      JSON.stringify({
        imports: [join(root, 'library/definitions.jsonc')],
        profiles: {
          'global-child': {
            extends: 'global-parent',
            layers: [
              { componentGroup: 'native-preview' },
              { configurationPreset: 'native-model', target: { agents: ['build'] } },
            ],
          },
        },
        activeProfiles: [],
      }),
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
    await assert.rejects(snapshot(), /Duplicate native agent identity/);
    await rm(join(project, '.opencode/agent/project-md.md'));
    await host.start({
      variables: { COMPOSER_FIXTURE_AGENT_MODEL: 'fixture/project-pin' },
      configContent: { model: 'fixture/native' },
    });
    const api = <T>(path: string, method = 'GET', body?: unknown) => host.api<T>(path, body, method);
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
    const sharedPath = join(configRoot, 'config-composer.jsonc');
    const sharedText = await readFile(sharedPath, 'utf8');
    await rm(sharedPath);
    const emptySnapshot = await snapshot();
    assert.equal(emptySnapshot.sources.documents.length, 0);
    const firstSource = planScope(emptySnapshot, 'shared', { operation: 'create' });
    await saveFilePlan(firstSource, async () => {
      await previewFilePlan(firstSource);
    });
    const savedEmpty = await snapshot();
    await reloadConfiguration(savedEmpty, async (plugin) => {
      await api('/global/config', 'PATCH', { plugin });
    });
    assert.equal((await runtime()).baseline.model, 'fixture/native');
    assert.equal(await readFile(sharedPath, 'utf8'), '{}\n');
    await writeFile(sharedPath, sharedText);
    await api('/instance/dispose', 'POST');
    const baseline = await api<Agent[]>('/agent');
    const conversation = await api<{ id: string; title: string }>('/session', 'POST', {
      title: 'Existing project conversation',
    });
    const runtimeLocation = (await runtime()).location;
    const localBaseline = join(project, '.opencode/config-composer.local.jsonc');
    await writeFile(localBaseline, '{"activeProfiles":["global-child"]}');
    await api('/instance/dispose', 'POST');
    const composed = await api<Record<string, unknown>>('/config');
    assert.equal(composed.model, 'fixture/composer', 'the profile global override applies');
    const native = readRuntimeBaseline(composed, runtimeLocation, configRoot);
    assert.equal(native.model, 'fixture/native', 'native config-content input supersedes disk model');
    process.env.COMPOSER_FIXTURE_AGENT_MODEL = 'fixture/different-client-environment';
    await assert.rejects(snapshot(), /same environment.*restart/s);
    process.env.COMPOSER_FIXTURE_AGENT_MODEL = 'fixture/project-pin';
    const parentSnapshot = await snapshot();
    const clearParent = planDefinition(parentSnapshot, {
      operation: 'patch',
      registry: 'profiles',
      name: 'global-child',
      path: ['extends'],
      value: undefined,
    });
    const clearedParent = await previewDefinition(clearParent);
    assert.equal(clearedParent.resolved.model, 'fixture/native');
    assert.equal(
      clearedParent.resolved.agent.build.model,
      'fixture/native',
      'native model reference uses restored fallback',
    );
    await saveFilePlan(clearParent, async () => {
      await previewDefinition(clearParent);
    });
    await api('/instance/dispose', 'POST');
    assert.equal((await api<Record<string, unknown>>('/config')).model, 'fixture/native');
    assert.deepEqual((await api<Agent[]>('/agent')).find((agent) => agent.name === 'build')?.model, {
      providerID: 'fixture',
      modelID: 'native',
    });
    assert.ok(!(await readFile(join(configRoot, 'opencode.json'), 'utf8')).includes('__configComposerRuntime'));
    await rm(localBaseline);
    await api('/instance/dispose', 'POST');
    const observed = await snapshot();
    assert.ok(observed.agents.some((agent) => agent.name === 'project-json'));
    assert.ok(observed.agents.some((agent) => agent.name === 'project-md'));
    assert.ok(observed.agents.some((agent) => agent.name === 'ancestor'));
    assert.equal(observed.nativeAgents['project-md'].model, undefined);
    await savePlan(
      planChange(observed, { kind: 'membership', agent: 'project-md', groups: ['work', 'editor-created'] }),
    );
    assert.equal(((await snapshot()).config.agent as Record<string, unknown> | undefined)?.['project-md'], undefined);
    assert.equal(await readFile(join(project, 'opencode.jsonc'), 'utf8'), projectJson);
    assert.equal(await readFile(join(project, '.opencode/agents/project-md.md'), 'utf8'), projectMarkdown);
    assert.deepEqual(
      baseline
        .filter((item) => item.native)
        .map((item) => item.name)
        .sort(),
      [...nativeAgentNames].sort(),
      'verify the complete pinned native identity catalog',
    );
    assert.ok(!baseline.some((item) => item.name === 'reviewer'), 'definitions alone do not activate custom agents');
    for (const change of [
      {
        operation: 'create',
        registry: 'profiles',
        name: 'editor-profile',
        sourceId: await realpath(join(configRoot, 'config-composer.jsonc')),
      },
      {
        operation: 'patch',
        registry: 'profiles',
        name: 'editor-profile',
        path: ['layers'],
        value: [{ componentGroup: 'work' }],
      },
      { operation: 'rename', registry: 'profiles', name: 'editor-profile', nextName: 'edited-profile' },
    ] as const) {
      const plan = planDefinition(
        await snapshot(),
        change.operation === 'patch' ? { ...change, path: [...change.path] } : change,
      );
      await saveFilePlan(plan, async () => {
        await previewDefinition(plan);
      });
    }
    assert.deepEqual((await snapshot()).sources.activeProfiles, []);
    await activate(['edited-profile', 'work']);
    await api('/instance/dispose', 'POST');
    const activated = await api<Agent[]>('/agent');
    const skills = await api<{ name: string; location: string }[]>('/skill');
    const checks = skills.find((item) => item.name === 'checks');
    assert.ok(checks !== undefined);
    assert.equal(await realpath(checks.location), await realpath(join(root, 'library/checks/SKILL.md')));
    const skillRule: Agent['permission'][number] = {
      permission: 'external_directory',
      pattern: join(dirname(checks.location), '*'),
      action: 'allow',
    };
    const normalizeBundled = await bundledPermissions(host);
    const normalizeRegistry = (agents: Agent[]) =>
      agents.map((agent) => ({ ...agent, permission: normalizeBundled(agent.permission) }));
    for (const before of baseline.filter((item) => item.native)) {
      const after = activated.find((item) => item.name === before.name);
      assert.ok(after !== undefined, before.name);
      assert.equal(after.native, true);
      assert.equal(after.prompt ?? undefined, before.prompt ?? undefined, `preserve ${before.name} native prompt`);
      assert.equal(after.mode, before.mode);
      assert.equal(after.hidden ?? undefined, before.hidden ?? undefined);
      assert.ok(after.permission.some((rule) => JSON.stringify(rule) === JSON.stringify(skillRule)));
      assert.deepEqual(
        normalizeBundled(after.permission.filter((rule) => rule.pattern !== skillRule.pattern)),
        normalizeBundled(before.permission),
      );
      assert.deepEqual(after.model, {
        providerID: 'fixture',
        modelID: before.name === 'plan' ? 'pinned' : before.name === 'build' ? 'beta' : 'alpha',
      });
    }
    assert.equal(activated.find((item) => item.name === 'project-json')?.prompt, 'Native project JSON body.');
    assert.deepEqual(activated.find((item) => item.name === 'project-json')?.model, {
      providerID: 'fixture',
      modelID: 'project-pin',
    });
    assert.deepEqual(activated.find((item) => item.name === 'project-md')?.model, {
      providerID: 'fixture',
      modelID: 'alpha',
    });
    assert.equal(activated.find((item) => item.name === 'project-md')?.prompt, 'Native project Markdown body.');
    const reviewer = activated.find((item) => item.name === 'reviewer');
    assert.ok(reviewer !== undefined);
    assert.equal(reviewer.mode, 'subagent');
    assert.equal(reviewer.prompt, 'Native custom body.');
    assert.deepEqual(reviewer.model, { providerID: 'fixture', modelID: 'alpha' });
    assert.deepEqual(reviewer.options.groups, ['work']);
    const commands = await api<{ name: string; agent?: string }[]>('/command');
    assert.equal(commands.find((item) => item.name === 'review')?.agent, 'reviewer');
    await activate([]);
    await api('/instance/dispose', 'POST');
    const cleared = await api<Agent[]>('/agent');
    assert.deepEqual(
      normalizeRegistry(cleared),
      normalizeRegistry(baseline),
      'empty local selection restores the native registry with equivalent bundled directory grants',
    );
    await activate();
    await api('/instance/dispose', 'POST');
    assert.deepEqual(
      normalizeRegistry(await api<Agent[]>('/agent')),
      normalizeRegistry(baseline),
      'absent local selection inherits empty shared selection',
    );
    const retained = await api<{ id: string; title: string }>(`/session/${conversation.id}`);
    assert.equal(retained.id, conversation.id);
    assert.equal(retained.title, conversation.title);
  },
);
