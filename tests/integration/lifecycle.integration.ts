import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { nativeHarness } from './harness.ts';
import type * as Storage from '../../src/config-composer/storage.ts';

interface Agent {
  name: string;
  model?: { modelID: string };
  variant?: string;
  prompt?: string;
}
interface Message {
  info: { modelID: string; error?: unknown };
  parts: { type: string; text?: string; tool?: string; state?: { status: string; output?: string; error?: string } }[];
}

test(
  'saved settings, native permission decisions, validation and restart persistence',
  { timeout: 240_000 },
  async (t) => {
    const host = await nativeHarness(t, 'lifecycle');
    const { configRoot, project, installed, api, requests } = host;
    // Exercise the actual installed editor implementation; the source import above is type-only.
    const storage = (await import(
      pathToFileURL(join(installed.directory, 'dist/config-composer/storage.js')).href
    )) as typeof Storage;
    await mkdir(join(configRoot, 'settings', 'prompts'), { recursive: true });
    await mkdir(join(configRoot, 'agents'), { recursive: true });
    await mkdir(join(configRoot, 'skills', 'included-skill'), { recursive: true });
    const nativePath = join(configRoot, 'opencode.jsonc');
    const settingsPath = join(configRoot, 'settings', 'composer.jsonc');
    const agentPath = join(configRoot, 'agents', 'worker.md');
    const model = {
      name: 'Fixture model',
      limit: { context: 8192, output: 256 },
      variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
    };
    await writeFile(
      nativePath,
      '// Native settings retained by editor\n' +
        JSON.stringify(
          {
            plugin: [[installed.directory, { configFile: 'settings/composer.jsonc' }]],
            model: 'fixture/alpha',
            small_model: 'fixture/alpha',
            default_agent: 'worker',
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
              build: { groups: [] },
              plan: { groups: [] },
              explore: { groups: [] },
              pinned: {
                mode: 'primary',
                groups: ['workers'],
                model: 'fixture/alpha',
                variant: 'low',
                prompt: 'PINNED_PROMPT',
              },
              ...Object.fromEntries(
                ['allow', 'deny', 'ask'].map((action) => [
                  action,
                  {
                    mode: 'primary',
                    groups: ['workers'],
                    prompt: `Permission fixture ${action}`,
                    permission: { skill: { 'included-skill': action } },
                  },
                ]),
              ),
            },
          },
          null,
          2,
        ),
    );
    const composer = {
      sourceDirectories: { shared: './prompts' },
      agent: {
        modelPresets: { balanced: { model: 'fixture/alpha', variant: 'low' } },
        groups: {
          workers: { modelRef: 'preset:balanced', prompt: { prepend: ['GROUP_START'], append: ['GROUP_END'] } },
        },
        prompts: {
          defaults: { prepend: ['DEFAULT_START'], append: ['DEFAULT_END'] },
          overrides: { pinned: { inheritDefaults: false, append: ['PINNED_END'] } },
        },
      },
      command: {},
      skill: {},
    };
    const settingsText = '// Dedicated custom settings\n' + JSON.stringify(composer, null, 2);
    await writeFile(settingsPath, settingsText);
    await writeFile(join(configRoot, 'settings', 'prompts', 'body.md'), 'INITIAL_BODY');
    await writeFile(join(configRoot, 'settings', 'prompts', 'skill.md'), 'EXPANDED_SKILL_SECRET');
    await writeFile(agentPath, '---\nmode: primary\ngroups: [workers]\n---\n{{include:@shared/body.md}}\n');
    await writeFile(
      join(configRoot, 'skills', 'included-skill', 'SKILL.md'),
      '---\nname: included-skill\ndescription: A deterministic permission fixture\n---\n{{include:@shared/skill.md}}\n',
    );
    await writeFile(
      join(project, 'README.md'),
      '# Fixture project\nA project with its own settings and persistent sessions.\n',
    );
    await host.start();
    const agent = async (name = 'worker') => {
      const found = (await api<Agent[]>('/agent')).find((item) => item.name === name);
      assert.ok(found !== undefined);
      return found;
    };
    const reload = async () =>
      storage.reloadConfiguration(await storage.loadSnapshot(configRoot), async (plugins) => {
        await api('/global/config', { plugin: plugins }, 'PATCH');
      });
    const send = async (
      agentName = 'worker',
      text = 'Reply with verified.',
      sessionID?: string,
      selection?: Record<string, unknown>,
    ) => {
      const session =
        sessionID === undefined
          ? await api<{ id: string }>('/session', { title: 'Integration fixture' })
          : { id: sessionID };
      const message = await api<Message>(`/session/${session.id}/message`, {
        agent: agentName,
        ...selection,
        parts: [{ type: 'text', text }],
      });
      assert.equal(message.info.error, undefined, JSON.stringify(message.info.error));
      return { session, message };
    };
    await t.test('custom settings and relative includes reach native provider in composition order', async () => {
      const { message } = await send();
      assert.equal(message.info.modelID, 'alpha');
      const captured = JSON.stringify(requests.at(-1)?.messages);
      const ordered = ['DEFAULT_START', 'GROUP_START', 'INITIAL_BODY', 'DEFAULT_END', 'GROUP_END'];
      for (const [index, marker] of ordered.entries()) {
        assert.ok(captured.includes(marker), marker);
        if (index > 0) {
          assert.ok(captured.indexOf(marker) > captured.indexOf(ordered[index - 1]));
        }
      }
      assert.equal(requests.at(-1)?.reasoning_effort, 'low');
      const pinned = await agent('pinned');
      assert.ok(pinned.prompt?.includes('DEFAULT_START') !== true);
      assert.equal(pinned.prompt?.includes('PINNED_END'), true);
    });
    await t.test('save waits for explicit reload and reload removes stale content without duplication', async () => {
      await storage.savePlan(
        storage.planChange(await storage.loadSnapshot(configRoot), {
          kind: 'preset',
          name: 'balanced',
          choice: { model: 'fixture/beta', variant: 'high' },
        }),
      );
      await writeFile(join(configRoot, 'settings', 'prompts', 'body.md'), 'SAVED_BODY');
      assert.equal((await send()).message.info.modelID, 'alpha', 'saving does not apply cached settings');
      assert.ok(JSON.stringify(requests.at(-1)?.messages).includes('INITIAL_BODY'));
      await reload();
      assert.equal((await send()).message.info.modelID, 'beta');
      assert.equal(requests.at(-1)?.reasoning_effort, 'high');
      assert.ok(!JSON.stringify(requests.at(-1)?.messages).includes('INITIAL_BODY'));
      await reload();
      const prompt = (await agent()).prompt ?? '';
      assert.equal(prompt.split('SAVED_BODY').length - 1, 1);
      assert.equal(prompt.split('GROUP_START').length - 1, 1);
      assert.equal((await agent('pinned')).model?.modelID, 'alpha');
      await send('worker', 'Explicit session model', undefined, {
        model: { providerID: 'fixture', modelID: 'alpha' },
        variant: 'low',
      });
      assert.equal(requests.at(-1)?.model, 'alpha');
      assert.equal(requests.at(-1)?.reasoning_effort, 'low');
      assert.match(await readFile(nativePath, 'utf8'), /^\/\/ Native settings retained/);
      assert.match(await readFile(settingsPath, 'utf8'), /^\/\/ Dedicated custom settings/);
    });
    await t.test(
      'JSONC built-in membership and custom frontmatter share groups without replacing native behavior',
      async () => {
        const baseline = await api<Record<string, unknown>[]>('/agent');
        for (const name of ['build', 'plan', 'explore']) {
          const original = baseline.find((item) => item.name === name);
          assert.ok(original?.native === true, `${name} must be native in the pinned host`);
          await storage.savePlan(
            storage.planChange(await storage.loadSnapshot(configRoot), {
              kind: 'membership',
              agent: name,
              groups: ['workers'],
            }),
          );
          await reload();
          const current = (await api<Record<string, unknown>[]>('/agent')).find((item) => item.name === name);
          assert.ok(current !== undefined);
          const { model: _oldModel, variant: _oldVariant, options: _oldOptions, ...oldBehavior } = original;
          const { model: _model, variant: _variant, options: _options, ...nativeBehavior } = current;
          assert.deepEqual(
            nativeBehavior,
            oldBehavior,
            `${name}: preserve all unspecified native fields and permission rules`,
          );
          assert.deepEqual((current.options as Record<string, unknown>).groups, ['workers']);
          assert.equal((await send(name)).message.info.modelID, 'beta');
          assert.equal(requests.at(-1)?.reasoning_effort, 'high');
        }
        assert.deepEqual(
          await readdir(join(configRoot, 'agents')),
          ['worker.md'],
          'built-ins have no shadow Markdown definitions',
        );
        const snapshot = await storage.loadSnapshot(configRoot);
        for (const name of ['build', 'plan', 'explore']) {
          assert.equal(snapshot.agents.find((item) => item.name === name)?.markdown, undefined);
        }
        assert.deepEqual(snapshot.agents.find((item) => item.name === 'worker')?.settings.groups, ['workers']);
        assert.equal((await send()).message.info.modelID, 'beta');
      },
    );
    await t.test('ordered membership edits and explicit pins change actual model dispatch', async () => {
      const change = async (value: Storage.Change) => {
        await storage.savePlan(storage.planChange(await storage.loadSnapshot(configRoot), value));
        await reload();
      };
      await change({
        kind: 'group',
        name: 'alternate',
        choice: { model: 'fixture/alpha', variant: 'low', prompt: { append: ['ALTERNATE_GROUP'] } },
      });
      await change({ kind: 'membership', agent: 'worker', groups: ['workers', 'alternate'] });
      assert.equal((await send()).message.info.modelID, 'alpha');
      assert.equal(requests.at(-1)?.reasoning_effort, 'low');
      assert.ok(JSON.stringify(requests.at(-1)?.messages).includes('ALTERNATE_GROUP'));
      await change({ kind: 'membership', agent: 'build', groups: ['workers', 'alternate'] });
      assert.equal((await send('build')).message.info.modelID, 'alpha');
      await change({ kind: 'membership', agent: 'worker', groups: ['alternate', 'workers'] });
      await change({ kind: 'membership', agent: 'build', groups: ['alternate', 'workers'] });
      assert.equal((await send('build')).message.info.modelID, 'beta');
      assert.equal((await send()).message.info.modelID, 'beta');
      assert.equal(requests.at(-1)?.reasoning_effort, 'high');
      await change({ kind: 'override', agent: 'worker', choice: { model: 'fixture/alpha', variant: 'low' } });
      assert.equal((await send()).message.info.modelID, 'alpha');
      assert.equal(requests.at(-1)?.reasoning_effort, 'low');
      await change({ kind: 'override', agent: 'worker', choice: {} });
      assert.equal((await send()).message.info.modelID, 'beta');
      await change({ kind: 'membership', agent: 'worker', groups: ['workers'] });
      assert.ok((await agent()).prompt?.includes('ALTERNATE_GROUP') !== true);
      assert.equal((await send('pinned')).message.info.modelID, 'alpha');
      assert.equal(requests.at(-1)?.reasoning_effort, 'low');
    });
    await t.test('native skill allow, deny and interactive ask decisions affect actual tool results', async () => {
      for (const action of ['allow', 'deny', 'ask']) {
        const session = await api<{ id: string }>('/session', { title: `Skill ${action}` });
        const before = requests.length;
        const pending = send(action, 'Load included-skill now.', session.id);
        // Observe errors immediately while the ask case is awaiting a native permission response.
        const completed = pending.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if (action === 'ask') {
          let permission: { id: string; sessionID: string; permission: string; patterns: string[] } | undefined;
          for (let attempt = 0; attempt < 200; attempt++) {
            permission = (await api<(typeof permission)[]>('/permission')).find(
              (item) => item?.sessionID === session.id,
            );
            if (permission !== undefined) {
              break;
            }
            await setTimeout(50);
          }
          assert.ok(permission !== undefined, 'native host must ask before executing the skill');
          assert.equal(permission.permission, 'skill');
          assert.ok(permission.patterns.includes('included-skill'));
          assert.ok(!JSON.stringify(requests.slice(before)).includes('EXPANDED_SKILL_SECRET'));
          await api(`/permission/${permission.id}/reply`, { reply: 'once' });
        }
        const outcome = await completed;
        if ('error' in outcome) {
          throw outcome.error;
        }
        const messages = await api<Message[]>(`/session/${session.id}/message`);
        const tool = messages.flatMap((message) => message.parts).find((part) => part.tool === 'skill');
        assert.ok(tool?.state !== undefined, `${action}: ${JSON.stringify(messages)}`);
        assert.equal(tool.state.status, action === 'deny' ? 'error' : 'completed');
        if (action === 'deny') {
          assert.match(tool.state.error ?? '', /rule which prevents you from using this specific tool call/);
          assert.ok(!JSON.stringify(requests.slice(before)).includes('EXPANDED_SKILL_SECRET'));
        } else {
          assert.match(tool.state.output ?? '', /EXPANDED_SKILL_SECRET/);
          assert.ok(JSON.stringify(requests.slice(before)).includes('EXPANDED_SKILL_SECRET'));
        }
      }
    });
    await t.test(
      'invalid and concurrent edits preserve all original files and leave no lock or temporary writes',
      async () => {
        const snapshot = await storage.loadSnapshot(configRoot);
        const bytes = await Promise.all(snapshot.files.map((file) => readFile(file.path, 'utf8')));
        assert.throws(() => storage.planChange(snapshot, { kind: 'deletePreset', name: 'balanced' }), /referenced/);
        assert.throws(
          () => storage.planChange(snapshot, { kind: 'preset', name: 'invalid', choice: {} }),
          /concrete model/,
        );
        const plan = storage.planChange(snapshot, { kind: 'all', choice: { model: 'fixture/alpha', variant: 'low' } });
        await writeFile(join(configRoot, '.config-composer.lock'), 'another editor');
        await assert.rejects(storage.savePlan(plan), /Another settings edit/);
        await unlink(join(configRoot, '.config-composer.lock'));
        assert.deepEqual(await Promise.all(snapshot.files.map((file) => readFile(file.path, 'utf8'))), bytes);
        await writeFile(agentPath, (await readFile(agentPath, 'utf8')) + '\nConcurrent edit\n');
        const concurrent = await Promise.all(snapshot.files.map((file) => readFile(file.path, 'utf8')));
        await assert.rejects(storage.savePlan(plan), /Settings changed/);
        assert.deepEqual(await Promise.all(snapshot.files.map((file) => readFile(file.path, 'utf8'))), concurrent);
        assert.ok(
          !(
            await Promise.all(
              [...new Set(snapshot.files.map((file) => dirname(file.path)))].map((directory) => readdir(directory)),
            )
          )
            .flat()
            .some((file) => file === '.config-composer.lock' || file.endsWith('.tmp')),
        );
      },
    );
    await t.test('membership replacement and removal clear group contributions on reload', async () => {
      await storage.savePlan(
        storage.planChange(await storage.loadSnapshot(configRoot), { kind: 'membership', agent: 'worker', groups: [] }),
      );
      await reload();
      assert.ok((await agent()).prompt?.includes('GROUP_START') !== true);
      assert.equal((await send()).message.info.modelID, 'alpha');
      await storage.savePlan(
        storage.planChange(await storage.loadSnapshot(configRoot), {
          kind: 'membership',
          agent: 'worker',
          groups: ['workers'],
        }),
      );
      await reload();
      assert.equal((await send()).message.info.modelID, 'beta');
    });
    await t.test('multi-file save and restart retain settings and sessions without stale process state', async () => {
      await storage.savePlan(
        storage.planChange(await storage.loadSnapshot(configRoot), {
          kind: 'all',
          choice: { model: 'fixture/alpha', variant: 'low' },
        }),
      );
      await reload();
      const saved = await send();
      const snapshot = await storage.loadSnapshot(configRoot);
      assert.equal(snapshot.config.model, 'fixture/alpha');
      assert.equal(snapshot.config.small_model, 'fixture/alpha');
      assert.equal(snapshot.modelPresets.balanced.model, 'fixture/alpha');
      await host.stop();
      await host.start();
      assert.equal((await agent()).model?.modelID, 'alpha');
      assert.equal(
        (await send('worker', 'Continue the saved session.', saved.session.id)).message.info.modelID,
        'alpha',
      );
      assert.ok((await api<Message[]>(`/session/${saved.session.id}/message`)).length >= 4);
    });
    await t.test(
      'failed prompt composition leaves native settings unmodified and a corrected reload recovers',
      async () => {
        const bodyPath = join(configRoot, 'settings', 'prompts', 'body.md');
        const goodBody = await readFile(bodyPath, 'utf8');
        const before = requests.length;
        await writeFile(bodyPath, '{{include:@shared/../outside.md}}');
        await reload();
        // OpenCode catches config-hook errors. Verify transactional composition rather
        // than claiming that the host prevents later requests with native settings.
        const rejected = await agent();
        assert.ok(rejected.prompt?.includes('{{include:@shared/body.md}}') === true);
        assert.equal(rejected.model, undefined);
        assert.ok(!rejected.prompt.includes('DEFAULT_START'));
        assert.ok((await agent('pinned')).prompt?.includes('GROUP_START') !== true);
        assert.equal(requests.length, before, 'reading configuration makes no provider request');
        await writeFile(bodyPath, goodBody);
        await reload();
        assert.equal((await send()).message.info.modelID, 'alpha');
      },
    );
    await t.test(
      'invalid saved configuration is rejected without changing active settings, and repair can be applied',
      async () => {
        const good = await readFile(settingsPath, 'utf8');
        const nativeBefore = await readFile(nativePath, 'utf8');
        const activeBefore = await agent();
        await writeFile(settingsPath, '{ "agent": { "groups": ');
        await assert.rejects(reload(), /invalid Config Composer JSONC/);
        assert.equal(await readFile(settingsPath, 'utf8'), '{ "agent": { "groups": ');
        assert.equal(await readFile(nativePath, 'utf8'), nativeBefore);
        assert.deepEqual(await agent(), activeBefore);
        assert.equal((await send()).message.info.modelID, 'alpha');
        await writeFile(settingsPath, good);
        await reload();
        assert.equal((await send()).message.info.modelID, 'alpha');
      },
    );
  },
);
