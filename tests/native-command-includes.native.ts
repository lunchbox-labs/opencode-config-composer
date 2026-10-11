import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
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
    `OpenCode ${scope} directory and JSONC commands compose includes across reload and profile reset`,
    { timeout: 300_000 },
    async (t) => {
      const host = await nativeHarness(t, `command-includes-${scope}`);
      const directory = scope === 'shared' ? host.configRoot : join(host.project, '.opencode');
      await mkdir(join(directory, 'commands'), { recursive: true });
      await mkdir(join(directory, 'prompts'));
      await writeFile(join(directory, 'prompts/nested.txt'), 'Nested $ARGUMENTS $1');
      await writeFile(join(directory, 'prompts/body.md'), 'Included {{include:@prompts/nested.txt}}');
      const composerPath = join(directory, 'config-composer.jsonc');
      const composer = {
        sourceDirectories: { prompts: './prompts' },
        profiles: { a: { overrides: { model: 'fixture/a' } }, b: { overrides: { model: 'fixture/b' } } },
      };
      await writeFile(composerPath, JSON.stringify({ ...composer, activeProfiles: ['a'] }));
      const body =
        'Start {{include:@prompts/body.md}} end $ARGUMENTS $1 !`echo native` \\{{include:@unknown/literal.md}}';
      const metadata = {
        description: 'Native include command',
        agent: 'build',
        model: 'fixture/pinned',
        subtask: true,
      };
      const markdown = join(directory, 'commands/from-directory.md');
      await writeFile(
        markdown,
        `---\ndescription: ${metadata.description}\nagent: build\nmodel: fixture/pinned\nsubtask: true\n---\n${body}\n`,
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
      const expected =
        'Start Included Nested $ARGUMENTS $1 end $ARGUMENTS $1 !`echo native` {{include:@unknown/literal.md}}';
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
      await writeFile(join(directory, 'prompts/nested.txt'), 'Updated $ARGUMENTS');
      await editor.reload();
      const updated = await host.api<Command[]>('/command');
      assert.equal(
        updated.find((item) => item.name === 'from-json')?.template,
        expected.replace('Nested $ARGUMENTS $1', 'Updated $ARGUMENTS'),
      );
      assert.deepEqual(await Promise.all([markdown, jsonPath].map((path) => readFile(path, 'utf8'))), before);
      assert.equal(host.requests.length, 0, 'configuration checks send no model requests');
      await writeFile(join(directory, 'prompts/nested.txt'), '{{include:@missing/body.md}}');
      await writeFile(composerPath, JSON.stringify({ ...composer, activeProfiles: ['a'] }));
      assert.equal(await host.api('/instance/dispose', {}), true);
      // OpenCode catches config-hook errors and continues with native settings.
      // Composer must leave the command bodies and profile settings unapplied.
      const rejected = await host.api<{ model: string; command: Record<string, Command> }>('/config');
      assert.equal(rejected.model, 'fixture/native');
      assert.equal(rejected.command['from-directory'].template, body);
      assert.equal(rejected.command['from-json'].template, body);
      assert.match(host.stderr, /Prompt source missing does not exist/);
      await writeFile(join(directory, 'prompts/nested.txt'), 'Recovered');
      assert.equal(await host.api('/instance/dispose', {}), true);
      const recovered = await host.api<{ model: string; command: Record<string, Command> }>('/config');
      assert.equal(recovered.model, 'fixture/a');
      assert.equal(recovered.command['from-json'].template, expected.replace('Nested $ARGUMENTS $1', 'Recovered'));
      assert.deepEqual(await host.api('/global/config'), globalBefore);
      assert.equal(host.requests.length, 0);
    },
  );
}
