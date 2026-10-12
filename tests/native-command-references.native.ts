import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { installedEditor } from './integration/editor.ts';
import { nativeHarness } from './integration/harness.ts';

interface Command {
  name: string;
  template: string;
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

for (const scope of ['shared', 'project'] as const) {
  test(
    `OpenCode ${scope} directory and JSONC commands resolve by name across reload and profile reset`,
    { timeout: 300_000 },
    async (t) => {
      const host = await nativeHarness(t, `command-references-${scope}`);
      const directory = scope === 'shared' ? host.configRoot : join(host.project, '.opencode');
      await mkdir(join(directory, 'commands'), { recursive: true });
      const composerPath = join(directory, 'config-composer.jsonc');
      const composer = {
        componentGroups: { commands: { commands: ['from-directory', 'from-json'] } },
        profiles: {
          a: { layers: [{ componentGroup: 'commands' }], overrides: { model: 'fixture/a' } },
          b: { layers: [{ componentGroup: 'commands' }], overrides: { model: 'fixture/b' } },
        },
      };
      await writeFile(composerPath, JSON.stringify({ ...composer, activeProfiles: ['a'] }));
      const body = 'Native body $ARGUMENTS $1';
      const metadata = {
        description: 'Native named command',
        agent: 'build',
        model: 'fixture/pinned',
        subtask: true,
      };
      const markdown = join(directory, 'commands/different-file.md');
      await writeFile(
        markdown,
        `---\nname: from-directory\ndescription: ${metadata.description}\nagent: build\nmodel: fixture/pinned\nsubtask: true\n---\n${body}\n`,
      );
      const jsonPath = scope === 'shared' ? join(directory, 'opencode.jsonc') : join(host.project, 'opencode.jsonc');
      await writeFile(
        jsonPath,
        '// Native JSONC commands remain native.\n' +
          JSON.stringify({
            ...(scope === 'shared' ? { plugin: [host.installed.directory] } : {}),
            model: 'fixture/native',
            command: { 'from-json': { ...metadata, template: body } },
          }),
      );
      if (scope === 'project') {
        await writeFile(
          join(host.configRoot, 'opencode.jsonc'),
          JSON.stringify({ plugin: [host.installed.directory] }),
        );
        // A project command overrides the shared command before Composer sees config.command.
        await mkdir(join(host.configRoot, 'commands'));
        await writeFile(
          join(host.configRoot, 'commands/from-directory.md'),
          '---\ndescription: Shared fallback\n---\nShared fallback',
        );
      }
      const before = await Promise.all([markdown, jsonPath].map((path) => readFile(path, 'utf8')));
      await host.start();
      const editor = await installedEditor(host);
      const globalBefore = await host.api('/global/config');
      const expected = body;
      for (const activeProfiles of [['a'], ['b'], ['a'], []]) {
        await writeFile(composerPath, JSON.stringify({ ...composer, activeProfiles }));
        await editor.reload();
        const config = await host.api<{ model: string; command: Record<string, Omit<Command, 'name'>> }>('/config');
        assert.equal(config.model, activeProfiles.length === 0 ? 'fixture/native' : `fixture/${activeProfiles[0]}`);
        const commands = await host.api<Command[]>('/command');
        for (const name of ['from-directory', 'from-json']) {
          const command = commands.find((item) => item.name === name);
          assert.ok(command !== undefined, name);
          for (const [key, value] of Object.entries(metadata)) {
            assert.equal(command[key as keyof Command], value, `${name}.${key}`);
          }
          assert.equal(command.template, expected);
          assert.equal(config.command[name].template, expected);
        }
        assert.deepEqual(await host.api('/global/config'), globalBefore, 'shared native cache remains unchanged');
      }
      assert.deepEqual(await Promise.all([markdown, jsonPath].map((path) => readFile(path, 'utf8'))), before);
      assert.equal(host.requests.length, 0, 'configuration checks send no model requests');
    },
  );
}

test(
  'downstream command bodies preserve native name discovery, editor loading and reload',
  { timeout: 180_000 },
  async (t) => {
    const host = await nativeHarness(t, 'native-command-transform');
    const transformer = join(host.root, 'body-transform.mjs');
    await cp(new URL('./integration/fixtures/body-transform.mjs', import.meta.url), transformer);
    const nativePath = join(host.configRoot, 'opencode.jsonc');
    const authored = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: [host.installed.directory, [pathToFileURL(transformer).href, { agents: false }]],
      command: { review: { template: 'AUTHORED_COMMAND', agent: 'build', subtask: true } },
    });
    await writeFile(nativePath, authored);
    await writeFile(
      join(host.configRoot, 'config-composer.jsonc'),
      JSON.stringify({
        componentGroups: { review: { commands: ['review'] } },
        profiles: { review: { layers: [{ componentGroup: 'review' }] } },
        activeProfiles: ['review'],
      }),
    );
    await host.start();
    const editor = await installedEditor(host);
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await editor.snapshot();
      assert.equal(snapshot.nativeModels.commandNames?.includes('review'), true);
      assert.deepEqual(snapshot.resolved.diagnostics, []);
      const config = await host.api<{ command: Record<string, Omit<Command, 'name'>> }>('/config');
      assert.equal(config.command.review.template, 'AUTHORED_COMMAND\nDOWNSTREAM_COMMAND');
      assert.equal(config.command.review.agent, 'build');
      assert.equal(config.command.review.subtask, true);
      await editor.reload();
    }
    assert.equal(await readFile(nativePath, 'utf8'), authored);
    assert.equal(host.requests.length, 0);
  },
);
