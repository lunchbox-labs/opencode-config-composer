import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { nativeHarness } from './harness.ts';
import { installedEditor } from './editor.ts';
import type { CompositionDocument } from '../../src/config-composer/composition/document-types.ts';

interface Agent {
  name: string;
  model?: { modelID: string };
  variant?: string;
  prompt?: string;
}
interface Message {
  info: { modelID: string; error?: unknown; summary?: boolean; agent?: string };
  parts: { type: string; text?: string; tool?: string; state?: { status: string; output?: string } }[];
}
async function edit(path: string, keys: (string | number)[], value: unknown) {
  const before = await readFile(path, 'utf8');
  await writeFile(path, applyEdits(before, modify(before, keys, value, {})));
}
async function document(path: string): Promise<CompositionDocument> {
  return parse(await readFile(path, 'utf8')) as CompositionDocument;
}

test(
  'canonical profiles, imported components and installed editor changes reach native dispatch',
  { timeout: 300_000 },
  async (t) => {
    const host = await nativeHarness(t, 'canonical-dispatch');
    const { configRoot, root, project, installed, api, requests } = host;
    const { storage, snapshot, reload } = await installedEditor(host);
    const settings = join(configRoot, 'settings/composer.jsonc');
    const models = join(configRoot, 'settings/definitions/models.jsonc');
    const components = join(configRoot, 'settings/definitions/components.jsonc');
    const library = join(root, 'shared library');
    const external = join(library, 'definitions.jsonc');
    const reviewerPath = join(library, 'reviewer.md');
    const local = join(project, '.opencode/config-composer.local.jsonc');
    const projectSettings = join(project, '.opencode/config-composer.jsonc');
    const relativeFile = (from: string, to: string) => relative(dirname(from), to).replaceAll('\\', '/');
    for (const path of [
      dirname(models),
      join(configRoot, 'agents'),
      dirname(local),
      join(library, 'snippets'),
      join(library, 'included-skill'),
    ]) {
      await mkdir(path, { recursive: true });
    }
    const writeDocument = (path: string, value: CompositionDocument) =>
      writeFile(path, `// Fixture document\n${JSON.stringify(value, null, 2)}\n`);
    const model = {
      name: 'Synthetic canonical model',
      temperature: true,
      limit: { context: 8192, output: 256 },
      variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
    };
    await writeFile(
      join(configRoot, 'opencode.jsonc'),
      JSON.stringify(
        {
          plugin: [[installed.directory, { configFile: 'settings/composer.jsonc' }]],
          model: 'fixture/alpha',
          small_model: 'fixture/alpha',
          default_agent: 'build',
          enabled_providers: ['fixture'],
          provider: {
            fixture: {
              name: 'Local fixture',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: host.providerURL, apiKey: 'synthetic-test-key' },
              models: { alpha: model, beta: model },
            },
          },
          agent: {
            plan: { model: 'fixture/alpha', variant: 'low', temperature: 0.9, top_p: 0.95 },
            'main-follower': { mode: 'primary', prompt: 'NATIVE_MAIN' },
            'small-follower': { mode: 'primary', prompt: 'NATIVE_SMALL' },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(configRoot, 'agents/pinned.md'),
      '---\nmode: primary\nmodel: fixture/beta\nvariant: high\ngroups: [primary]\n---\nNATIVE_PINNED',
    );
    await writeFile(
      reviewerPath,
      '---\nmode: primary\ngroups: [primary]\npermission:\n  edit: deny\n---\nIMPORTED_REVIEWER {{include:@external/fragment.md}}',
    );
    await writeFile(join(library, 'snippets/fragment.md'), 'ORIGIN_RELATIVE_FRAGMENT');
    await writeFile(join(library, 'snippets/reference.md'), 'NAMED_PROMPT_REFERENCE');
    await writeFile(join(library, 'snippets/skill.md'), 'CANONICAL_SKILL_BODY');
    await writeFile(
      join(library, 'included-skill/SKILL.md'),
      '---\nname: included-skill\ndescription: Imported native skill\n---\n{{include:@external/skill.md}}',
    );
    await writeFile(
      join(library, 'review.md'),
      '---\nagent: reviewer\ndescription: Imported command\n---\nCOMMAND_BODY $ARGUMENTS {{include:@external/fragment.md}}',
    );
    await writeDocument(external, {
      sourceDirectories: { external: './snippets' },
      configurationPresets: { 'shared-read-only': { model: 'fixture/beta' } },
      components: {
        prompts: {
          reference: { file: './snippets/reference.md' },
          'inline-reference': { text: 'INLINE_PROMPT_REFERENCE' },
        },
        skills: { 'included-skill': { file: './included-skill/SKILL.md' } },
        commands: { 'fixture-review': { file: './review.md' } },
      },
    });
    await writeDocument(components, {
      imports: [relativeFile(components, external)],
      components: {
        agents: {
          reviewer: {
            file: relativeFile(components, reviewerPath),
            promptRefs: ['reference', 'inline-reference'],
            skills: ['included-skill'],
          },
          twin: { file: relativeFile(components, reviewerPath) },
          inline: { prompt: 'INLINE_AGENT_BODY', mode: 'primary', promptRefs: ['reference'] },
        },
      },
    });
    await writeDocument(models, {
      configurationPresets: {
        fast: {
          model: 'fixture/alpha',
          variant: 'low',
          parameters: { temperature: 0.2, topP: 0.6, maxOutputTokens: 96, options: { reasoningEffort: 'medium' } },
        },
        tuned: { modelRef: 'preset:fast', parameters: { topP: 0.7 } },
        big: { model: 'fixture/beta', variant: 'high' },
        'inactive-policy': { model: 'fixture/alpha', permissions: [{ tool: 'edit', action: 'deny' }] },
      },
    });
    await writeDocument(settings, {
      imports: ['./definitions/models.jsonc', './definitions/components.jsonc'],
      defaults: {
        model: 'fixture/alpha',
        small_model: 'fixture/alpha',
        agents: { prompt: { prepend: ['DEFAULT_PREFIX'] } },
      },
      componentGroups: {
        primary: {
          agents: ['build', 'plan', 'explore', 'inline'],
          commands: ['fixture-review'],
          skills: ['included-skill'],
          prompts: ['reference'],
          configuration: { modelRef: 'preset:tuned', prompt: { append: ['BASE_APPEND'] } },
        },
        focus: {
          agents: ['build', 'reviewer', 'inline'],
          configuration: { model: 'fixture/beta', variant: 'high', parameters: { topP: 0.8 } },
        },
        main: { agents: ['main-follower'], configuration: { modelRef: 'opencode:model' } },
        small: { agents: ['small-follower'], configuration: { modelRef: 'opencode:small_model' } },
        utility: {
          agents: ['title', 'compaction'],
          configuration: { model: 'fixture/alpha', parameters: { maxOutputTokens: 80, topP: 0.45 } },
        },
      },
      profiles: {
        base: {
          layers: [
            { componentGroup: 'primary' },
            { componentGroup: 'main' },
            { componentGroup: 'small' },
            { componentGroup: 'utility' },
          ],
        },
        work: { extends: 'base', layers: [{ componentGroup: 'focus' }] },
        targeted: {
          extends: 'base',
          layers: [{ configurationPreset: 'big', target: { agents: ['reviewer'], componentGroups: ['primary'] } }],
        },
        explicit: { extends: 'base', overrides: { agents: { plan: { model: 'fixture/beta', variant: 'high' } } } },
      },
      activeProfiles: ['work'],
    });
    await writeDocument(projectSettings, {
      defaults: { model: 'fixture/beta' },
      overrides: { small_model: 'fixture/beta' },
    });
    await writeFile(
      join(configRoot, 'settings/definitions/not-imported.jsonc'),
      '{ invalid and intentionally not discovered',
    );
    await writeDocument(local, { activeProfiles: [] });
    await snapshot();
    await host.start();
    const agents = () => api<Agent[]>('/agent');
    const findAgent = async (name: string) => (await agents()).find((agent) => agent.name === name);
    const activate = async (value: CompositionDocument) => {
      await writeDocument(local, value);
      await reload();
    };
    const restoreSourcesAfter = async (context: TestContext, paths: string[]) => {
      const saved = await Promise.all(paths.map(async (path) => ({ path, text: await readFile(path, 'utf8') })));
      context.after(async () => {
        // A failing assertion must not leave later cases with a pin or broken import.
        // This restores fixture input after the case; all behavior assertions run first.
        await Promise.all(saved.map(({ path, text }) => writeFile(path, text)));
        await reload();
      });
    };
    const send = async (agent = 'reviewer', selection: Record<string, unknown> = {}, sessionID?: string) => {
      const session =
        sessionID === undefined
          ? await api<{ id: string }>('/session', { title: 'Canonical integration' })
          : { id: sessionID };
      const message = await api<Message>(`/session/${session.id}/message`, {
        agent,
        ...selection,
        parts: [{ type: 'text', text: 'Reply with verified.' }],
      });
      assert.equal(message.info.error, undefined, JSON.stringify(message.info.error));
      assert.ok(message.parts.some((part) => part.text === 'verified'));
      return { session, message, captured: requests.at(-1)! };
    };
    const baseline = await agents();

    await t.test('definitions stay inactive until inherited profile selection enables relative imports', async () => {
      assert.equal(await findAgent('reviewer'), undefined);
      assert.equal(
        (await api<{ name: string }[]>('/command')).some((item) => item.name === 'fixture-review'),
        false,
      );
      assert.equal(
        (await api<{ name: string }[]>('/skill')).some((item) => item.name === 'included-skill'),
        false,
      );
      await activate({});
      assert.deepEqual((await snapshot()).sources.activeProfiles, ['work']);
      const { message, captured } = await send();
      assert.equal(message.info.modelID, 'beta');
      assert.equal(captured.top_p, 0.8);
      assert.equal(captured.reasoning_effort, 'high');
      assert.notEqual(captured.temperature, 0.2, 'model change clears parameters from the inherited alpha model');
      assert.notEqual(captured.max_tokens, 96);
      const text = JSON.stringify(captured.messages);
      for (const marker of [
        'DEFAULT_PREFIX',
        'IMPORTED_REVIEWER',
        'ORIGIN_RELATIVE_FRAGMENT',
        'NAMED_PROMPT_REFERENCE',
        'INLINE_PROMPT_REFERENCE',
        'BASE_APPEND',
      ]) {
        assert.ok(text.includes(marker), marker);
      }
      assert.ok(!text.includes('CANONICAL_SKILL_BODY'), 'skill relationships do not inject their bodies');
      assert.ok(!text.includes('{{include:'));
      assert.deepEqual(
        await readdir(join(configRoot, 'agents')),
        ['pinned.md'],
        'native built-ins need no shadow files',
      );
    });

    await t.test(
      'ordered local replacement replays parent chains and maps merged parameters to captured requests',
      async () => {
        await activate({ activeProfiles: ['work', 'base'] });
        assert.deepEqual((await snapshot()).sources.activeProfiles, ['work', 'base']);
        const { captured } = await send();
        assert.equal(captured.model, 'alpha');
        assert.equal(captured.temperature, 0.2);
        assert.equal(captured.top_p, 0.7);
        assert.equal(captured.max_tokens, 96);
        assert.equal(captured.reasoning_effort, 'low', 'native variant options override generic Composer options');
        await activate({ activeProfiles: ['base', 'work'] });
        assert.equal((await send()).captured.model, 'beta');
        await activate({ activeProfiles: ['base'] });
        assert.equal((await send()).captured.model, 'alpha');
        const pinned = (await send('pinned')).captured;
        const selected = (
          await send('reviewer', { model: { providerID: 'fixture', modelID: 'beta' }, variant: 'high' })
        ).captured;
        for (const key of ['model', 'temperature', 'top_p', 'max_tokens', 'reasoning_effort']) {
          assert.deepEqual(selected[key], pinned[key], `session model keeps native ${key}`);
        }
        const plan = (await send('plan')).captured;
        assert.equal(plan.model, 'alpha');
        assert.equal(plan.temperature, 0.9);
        assert.equal(plan.top_p, 0.95);
      },
    );

    await t.test('targeted presets preserve native pins and explicit overrides can replace them', async () => {
      await activate({ activeProfiles: ['targeted'] });
      assert.equal((await send()).captured.model, 'beta');
      assert.equal((await send('build')).captured.model, 'beta');
      assert.equal((await send('plan')).captured.model, 'alpha');
      assert.equal((await send('pinned')).captured.model, 'beta');
      await activate({ activeProfiles: ['explicit'] });
      assert.equal((await send('plan')).captured.model, 'beta');
      await activate({ activeProfiles: ['base'] });
      assert.equal((await send('plan')).captured.model, 'alpha', 'removed override restores the native pin');
    });

    await t.test('shared, project and local model slots resolve late and clear without stale defaults', async () => {
      for (const name of ['main-follower', 'small-follower']) {
        assert.equal((await send(name)).captured.model, 'beta');
      }
      await activate({
        activeProfiles: ['base'],
        defaults: { model: 'fixture/alpha' },
        overrides: { small_model: 'fixture/alpha' },
      });
      for (const name of ['main-follower', 'small-follower']) {
        assert.equal((await send(name)).captured.model, 'alpha');
      }
      await activate({ activeProfiles: ['base'] });
      for (const name of ['main-follower', 'small-follower']) {
        assert.equal((await send(name)).captured.model, 'beta');
      }
      await writeDocument(projectSettings, {});
      await reload();
      for (const name of ['main-follower', 'small-follower']) {
        assert.equal((await send(name)).captured.model, 'alpha');
      }
      await writeDocument(projectSettings, {
        defaults: { model: 'fixture/beta' },
        overrides: { small_model: 'fixture/beta' },
      });
      await reload();
    });

    await t.test('imported commands execute and native skills expand only when called', async () => {
      const session = await api<{ id: string }>('/session', { title: 'Command integration' });
      const result = await api<Message>(`/session/${session.id}/command`, {
        command: 'fixture-review',
        arguments: 'fixture-input',
      });
      assert.equal(result.info.error, undefined);
      assert.ok(
        JSON.stringify(requests.at(-1)?.messages).includes('COMMAND_BODY fixture-input ORIGIN_RELATIVE_FRAGMENT'),
      );
      await api<Message>(`/session/${session.id}/message`, {
        agent: 'reviewer',
        parts: [{ type: 'text', text: 'Load included-skill now.' }],
      });
      const messages = await api<Message[]>(`/session/${session.id}/message`);
      const skill = messages.flatMap((message) => message.parts).find((part) => part.tool === 'skill');
      assert.equal(skill?.state?.status, 'completed', JSON.stringify(messages));
      assert.match(skill.state.output ?? '', /CANONICAL_SKILL_BODY/);
      assert.ok(JSON.stringify(requests.at(-1)?.messages).includes('CANONICAL_SKILL_BODY'));
    });

    await t.test('automatic title and compaction dispatch use their configured utility parameters', async () => {
      const start = requests.length;
      const session = await api<{ id: string }>('/session', {});
      await send('reviewer', {}, session.id);
      let title: string | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        title = (await api<{ title: string }>(`/session/${session.id}`)).title;
        if (title === 'verified') {
          break;
        }
        await setTimeout(50);
      }
      assert.equal(title, 'verified', 'the host saved the automatically generated title');
      const titleRequest = requests
        .slice(start)
        .find((request) => JSON.stringify(request.messages).includes('Generate a title for this conversation:'));
      assert.ok(titleRequest !== undefined, 'the native title path reached the provider');
      assert.equal(titleRequest.model, 'alpha');
      assert.equal(titleRequest.max_tokens, 80);
      assert.equal(titleRequest.top_p, 0.45);
      const beforeCompaction = requests.length;
      await api(`/session/${session.id}/summarize`, { providerID: 'fixture', modelID: 'alpha', auto: false });
      const messages = await api<Message[]>(`/session/${session.id}/message`);
      const summary = messages.find((message) => message.info.summary === true);
      assert.ok(summary !== undefined, 'native compaction persisted a summary message');
      assert.equal(summary.info.error, undefined);
      assert.ok(summary.parts.some((part) => part.text === 'verified'));
      assert.equal(summary.info.agent, 'compaction');
      const compactionRequests = requests.slice(beforeCompaction);
      assert.equal(compactionRequests.length, 1, 'manual compaction sends one summary request');
      const compaction = compactionRequests[0];
      assert.equal(compaction.max_tokens, 80);
      assert.equal(compaction.model, 'alpha');
      assert.equal(compaction.top_p, 0.45);
    });

    await t.test('imported preset edits preserve mixed data and stay unapplied until a real reload', async () => {
      const rootBefore = await readFile(settings, 'utf8');
      const sourceBefore = await document(models);
      const plan = storage.planChange(await snapshot(), {
        kind: 'preset',
        name: 'fast',
        choice: { model: 'fixture/beta', variant: 'high' },
      });
      assert.deepEqual(
        plan.edits.map((item) => item.file.path),
        [models],
      );
      await storage.savePlan(plan);
      assert.equal(await readFile(settings, 'utf8'), rootBefore);
      assert.deepEqual(
        (await document(models)).configurationPresets!.fast.parameters,
        sourceBefore.configurationPresets!.fast.parameters,
      );
      assert.equal((await send()).captured.model, 'alpha');
      await reload();
      const { captured } = await send();
      assert.equal(captured.model, 'beta');
      assert.equal(captured.temperature, 0.2);
      assert.equal(captured.top_p, 0.7);
      assert.equal(captured.max_tokens, 96);
      assert.equal(captured.reasoning_effort, 'high');
      await reload();
      assert.equal((await findAgent('reviewer'))!.prompt!.split('NAMED_PROMPT_REFERENCE').length - 1, 1);
      await storage.savePlan(
        storage.planChange(await snapshot(), {
          kind: 'preset',
          name: 'inactive-policy',
          choice: { model: 'fixture/beta' },
        }),
      );
      assert.deepEqual(
        (await document(models)).configurationPresets!['inactive-policy'].permissions,
        [{ tool: 'edit', action: 'deny' }],
        'preserve inactive permission data; this does not test its enforcement',
      );
      await reload();
      assert.equal((await send()).captured.model, 'beta');
      await storage.savePlan(
        storage.planChange(await snapshot(), {
          kind: 'preset',
          name: 'fast',
          choice: { model: 'fixture/alpha', variant: 'low' },
        }),
      );
      await reload();
    });

    await t.test('model and membership editors preserve mixed bundles and profile activation', async (context) => {
      await restoreSourcesAfter(context, [settings, components, reviewerPath]);
      const before = (await document(settings)).componentGroups!.primary;
      await storage.savePlan(
        storage.planChange(await snapshot(), {
          kind: 'group',
          name: 'primary',
          choice: { modelRef: 'opencode:model', variant: 'high' },
        }),
      );
      const after = (await document(settings)).componentGroups!.primary;
      for (const key of ['agents', 'commands', 'skills', 'prompts'] as const) {
        assert.deepEqual(after[key], before[key]);
      }
      assert.deepEqual(after.configuration!.prompt, before.configuration!.prompt);
      await reload();
      assert.equal((await send()).captured.model, 'beta');
      assert.notEqual((await send()).captured.temperature, 0.2);
      await storage.savePlan(
        storage.planChange(await snapshot(), {
          kind: 'group',
          name: 'primary',
          choice: { modelRef: 'preset:tuned' },
        }),
      );
      await reload();
      await storage.savePlan(
        storage.planChange(await snapshot(), { kind: 'membership', agent: 'inline', groups: ['focus'] }),
      );
      await reload();
      assert.equal(await findAgent('inline'), undefined, 'membership does not activate the focus profile');
      assert.deepEqual((await snapshot()).sources.activeProfiles, ['base']);
      await storage.savePlan(
        storage.planChange(await snapshot(), { kind: 'membership', agent: 'inline', groups: ['primary'] }),
      );
      await reload();
      assert.equal((await send('inline')).captured.model, 'alpha');
      assert.deepEqual(await readdir(join(configRoot, 'agents')), ['pinned.md']);
    });

    await t.test('shared component model overrides preserve Markdown and sibling inheritance', async (context) => {
      await restoreSourcesAfter(context, [components, reviewerPath]);
      const markdown = await readFile(reviewerPath, 'utf8');
      await storage.savePlan(
        storage.planChange(await snapshot(), {
          kind: 'override',
          agent: 'reviewer',
          choice: { model: 'fixture/beta', variant: 'high' },
        }),
      );
      assert.equal(await readFile(reviewerPath, 'utf8'), markdown);
      await reload();
      assert.equal((await send()).captured.model, 'beta');
      assert.equal((await send('twin')).captured.model, 'alpha');
      await storage.savePlan(storage.planChange(await snapshot(), { kind: 'override', agent: 'reviewer', choice: {} }));
      await reload();
      assert.equal((await send()).captured.model, 'alpha');
      assert.equal(await readFile(reviewerPath, 'utf8'), markdown);
    });

    await t.test('read-only imports, stale sources and invalid references reject before any save', async (context) => {
      await restoreSourcesAfter(context, [settings, models, external]);
      const current = await snapshot();
      assert.throws(
        () =>
          storage.planChange(current, { kind: 'preset', name: 'shared-read-only', choice: { model: 'fixture/alpha' } }),
        /Read-only/,
      );
      assert.throws(() => storage.planChange(current, { kind: 'deletePreset', name: 'fast' }), /referenced/);
      const pending = storage.planChange(current, { kind: 'preset', name: 'fast', choice: { model: 'fixture/beta' } });
      const original = await readFile(external, 'utf8');
      const before = await readFile(models, 'utf8');
      await writeFile(external, original + '\n// Concurrent external edit\n');
      await assert.rejects(storage.savePlan(pending), /Settings changed/);
      assert.equal(await readFile(models, 'utf8'), before);
      const good = await readFile(settings, 'utf8');
      await edit(settings, ['imports'], ['./definitions/missing.jsonc']);
      await assert.rejects(snapshot(), /missing|read|ENOENT/i);
      assert.equal(await readFile(models, 'utf8'), before);
      assert.equal((await send()).captured.model, 'alpha', 'failed preflight has not reloaded the active instance');
      await writeFile(settings, good);
      await reload();
    });

    await t.test(
      'restart retains imported edits, activation and session history; empty activation removes stale components',
      async () => {
        await storage.savePlan(
          storage.planChange(await snapshot(), {
            kind: 'preset',
            name: 'fast',
            choice: { model: 'fixture/beta', variant: 'high' },
          }),
        );
        await reload();
        const previous = await send();
        await host.stop();
        await host.start();
        assert.equal((await send('reviewer', {}, previous.session.id)).captured.model, 'beta');
        assert.ok((await api<Message[]>(`/session/${previous.session.id}/message`)).length >= 4);
        await activate({ activeProfiles: [] });
        await reload();
        assert.deepEqual(await agents(), baseline);
        assert.equal(
          (await api<{ name: string }[]>('/command')).some((item) => item.name === 'fixture-review'),
          false,
        );
        assert.equal(
          (await api<{ name: string }[]>('/skill')).some((item) => item.name === 'included-skill'),
          false,
        );
        assert.equal(
          (await api<{ model: string }>('/config')).model,
          'fixture/beta',
          'empty selection retains independent document defaults',
        );
      },
    );
  },
);
