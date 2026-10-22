import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { compositionFixture } from './composition-fixture.ts';

const promptPackage = '@lunchbox-labs/opencode-prompt-composer';
const promptVersion = '0.0.6';

for (const order of ['config-first', 'prompt-first']) {
  test(
    `published Prompt ${promptVersion} coexists ${order} through native profile apply and restart`,
    { timeout: 240000 },
    async (t) => {
      const f = await compositionFixture(t, `prompt-${order}`);
      const npm = process.env.npm_execpath;
      assert.ok(npm !== undefined, 'run native tests through npm');
      await promisify(execFile)(
        process.execPath,
        [
          npm,
          'install',
          '--ignore-scripts',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--save-exact',
          `${promptPackage}@${promptVersion}`,
        ],
        { cwd: f.host.configRoot, timeout: 120000 },
      );
      const promptDirectory = await realpath(join(f.host.configRoot, 'node_modules', promptPackage));
      const manifest = JSON.parse(await readFile(join(promptDirectory, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
      };
      assert.equal(manifest.name, promptPackage);
      assert.equal(manifest.version, promptVersion);
      const plugins = [f.host.installed.directory, promptDirectory];
      if (order === 'prompt-first') {
        plugins.reverse();
      }
      await f.write(f.paths.native, { ...f.native, plugin: plugins, agent: {}, command: {} });
      const projectConfig = join(f.host.project, '.opencode');
      for (const directory of ['agents', 'commands', 'prompts']) {
        await mkdir(join(projectConfig, directory), { recursive: true });
      }
      const inputs = {
        'agents/worker.md':
          '---\nmodel: fixture/alpha\nmode: primary\ntemperature: 0\noptions: { opaque: false }\npermission: { edit: deny }\ndescription: Opaque worker metadata\ncolor: "#112233"\n---\nWORKER_BODY {{include:agent.md}}',
        'agents/helper.md':
          '---\nmode: subagent\ndescription: Opaque helper metadata\n---\nHELPER_BODY {{include:agent.md}}',
        'commands/review.md':
          '---\nagent: helper\nmodel: fixture/alpha\nsubtask: false\ndescription: Opaque command metadata\n---\nCOMMAND_BODY {{include:command.md}} $ARGUMENTS',
        'prompts/agent.md': 'AGENT_INCLUDE',
        'prompts/command.md': 'COMMAND_INCLUDE',
        'prompts/shared.md': 'SHARED_APPEND',
        'prompt-composer.jsonc': JSON.stringify({
          defaults: { append: ['{{include:shared.md}}'] },
          agents: { worker: { prepend: ['WORKER_PREPEND'], append: ['WORKER_APPEND'] } },
        }),
      };
      for (const [path, text] of Object.entries(inputs)) {
        await writeFile(join(projectConfig, path), text);
      }
      const patch = {
        model: 'fixture/beta',
        temperature: 0.9,
        options: { configured: true },
        permission: { edit: 'allow' },
      };
      await f.write(f.paths.shared, {
        groups: [
          {
            name: 'workers',
            members: { agent: ['worker', 'helper'], command: ['review'] },
            agent: { model: 'fixture/alpha', temperature: 0.4, permission: { read: 'ask' } },
            command: { subtask: false },
          },
        ],
        agent: { worker: patch },
        profiles: {
          a: {
            groups: [{ name: 'workers', agent: patch }],
            agent: { worker: patch, helper: { model: 'fixture/beta', variant: 'high', options: { from_a: false } } },
            command: { review: { model: 'fixture/beta' } },
          },
          b: { agent: { helper: { model: 'fixture/alpha' } } },
        },
        defaultProfile: 'a',
      });
      const preserved = new Map<string, Buffer>();
      for (const path of [
        f.paths.native,
        f.paths.shared,
        ...Object.keys(inputs).map((path) => join(projectConfig, path)),
      ]) {
        preserved.set(path, await readFile(path));
      }
      const expectedWorker = 'WORKER_PREPEND\n\nWORKER_BODY AGENT_INCLUDE\n\nSHARED_APPEND\n\nWORKER_APPEND';
      const expectedHelper = 'HELPER_BODY AGENT_INCLUDE\n\nSHARED_APPEND';
      const expectedCommand = 'COMMAND_BODY COMMAND_INCLUDE $ARGUMENTS';
      const verify = async (profile: 'a' | 'b' | null) => {
        const config = await f.host.api<{
          plugin: [string, Record<string, Record<string, unknown>>][];
          agent: Record<string, Record<string, unknown>>;
          command: Record<string, Record<string, unknown>>;
        }>('/config');
        assert.equal(config.agent.worker.prompt, expectedWorker);
        assert.equal(config.agent.helper.prompt, expectedHelper);
        assert.equal(config.command.review.template, expectedCommand);
        assert.equal(config.agent.worker.model, 'fixture/alpha');
        assert.equal(config.agent.worker.temperature, 0);
        assert.deepEqual(config.agent.worker.options, { opaque: false });
        assert.deepEqual(config.agent.worker.permission, { edit: 'deny' });
        assert.equal(config.agent.worker.description, 'Opaque worker metadata');
        assert.equal(config.agent.worker.color, '#112233');
        assert.equal(config.agent.helper.description, 'Opaque helper metadata');
        assert.equal(config.command.review.description, 'Opaque command metadata');
        assert.equal(config.agent.helper.model, profile === 'a' ? 'fixture/beta' : 'fixture/alpha');
        assert.equal(config.agent.helper.temperature, profile === 'a' ? 0.9 : 0.4);
        assert.equal(config.agent.helper.variant, profile === 'a' ? 'high' : undefined);
        assert.deepEqual(config.agent.helper.options, profile === 'a' ? { from_a: false } : {});
        assert.equal(config.command.review.model, profile === 'a' ? 'fixture/beta' : 'fixture/alpha');
        assert.equal(config.command.review.subtask, false);
        assert.equal(
          config.plugin.filter(([, options]) => Object.hasOwn(options, '__configComposerRuntime')).length,
          1,
        );
        assert.equal(
          config.plugin.filter(([, options]) => Object.hasOwn(options, '__promptComposerRuntime')).length,
          1,
        );
        assert.deepEqual(
          config.plugin.map(([path]) => path),
          plugins.map((path) => pathToFileURL(path).href),
        );
        const prompt = config.plugin.find(([path]) => path === pathToFileURL(promptDirectory).href)?.[1]
          .__promptComposerRuntime;
        assert.ok(prompt !== undefined);
        assert.equal(prompt.version, 1);
        assert.deepEqual((prompt.applied as { agent: Record<string, { prompt: string }> }).agent.worker, {
          prompt: expectedWorker,
        });
        assert.match(
          (prompt.native as { agent: Record<string, { prompt: string }> }).agent.worker.prompt,
          /\{\{include:agent\.md\}\}/,
        );
        const runtime = await f.editor.runtime();
        assert.equal(runtime.status, 'applied');
        assert.equal(runtime.candidate?.profile, profile);
        assert.equal(runtime.native.agent?.worker.prompt, undefined);
        assert.equal(runtime.candidate.agent.worker.prompt, undefined);
        assert.equal(runtime.candidate.decisions['/agent/worker/model'].origin.kind, 'frontmatter');
        assert.equal(runtime.candidate.decisions['/agent/worker/model'].blockedComposer?.value, 'fixture/beta');
        await f.editor.context();
        const agents = await f.host.api<{ name: string; prompt?: string; model?: { modelID: string } }[]>('/agent');
        assert.equal(agents.find((agent) => agent.name === 'worker')?.prompt, expectedWorker);
        assert.equal(
          agents.find((agent) => agent.name === 'helper')?.model?.modelID,
          profile === 'a' ? 'beta' : 'alpha',
        );
        const commands = await f.host.api<{ name: string; template: string }[]>('/command');
        assert.equal(commands.find((command) => command.name === 'review')?.template, expectedCommand);
        return { config: runtime.id, prompt: prompt.id };
      };
      await f.host.start();
      let previous = await verify('a');
      for (const choice of ['a', 'b', 'a', null, undefined] as const) {
        const saved = await f.editor.select(choice);
        const revision = await f.editor.reload(saved);
        assert.deepEqual((await f.editor.runtime()).revision, revision);
        const ids = await verify(choice === undefined ? 'a' : choice);
        assert.notEqual(ids.config, previous.config);
        assert.notEqual(ids.prompt, previous.prompt);
        previous = ids;
      }
      await f.host.api('/instance/dispose', {});
      let ids = await verify('a');
      assert.notEqual(ids.config, previous.config);
      assert.notEqual(ids.prompt, previous.prompt);
      previous = ids;
      await f.host.stop();
      await f.host.start();
      ids = await verify('a');
      assert.notEqual(ids.config, previous.config);
      assert.notEqual(ids.prompt, previous.prompt);
      const sent = await f.send('helper');
      assert.equal(sent.captured.model, 'beta');
      for (const token of ['HELPER_BODY', 'AGENT_INCLUDE', 'SHARED_APPEND']) {
        assert.ok(JSON.stringify(sent.captured.messages).includes(token));
      }
      const session = await f.host.api<{ id: string }>('/session', { title: 'Composed command' });
      const before = f.host.requests.length;
      const response = await f.host.api<{ info: { error?: unknown } }>(`/session/${session.id}/command`, {
        command: 'review',
        arguments: 'dispatch proof',
      });
      assert.equal(response.info.error, undefined);
      assert.ok(
        f.host.requests
          .slice(before)
          .some(
            (request) =>
              request.model === 'beta' &&
              JSON.stringify(request.messages).includes('COMMAND_BODY COMMAND_INCLUDE dispatch proof'),
          ),
      );
      for (const [path, bytes] of preserved) {
        assert.deepEqual(await readFile(path), bytes, `native and independent source bytes remain unchanged: ${path}`);
      }
    },
  );
}
