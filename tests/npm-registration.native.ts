import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { npmRegistration } from './npm-registration.ts';
import { compositionFixture } from './integration/composition-fixture.ts';
import { nativeTerminal } from './integration/terminal.ts';

for (const registration of ['npm', 'relative-directory'] as const) {
  test(
    `native ${registration} registration discovers skills and slash commands and renders the actual TUI`,
    { timeout: 240_000 },
    async (t) => {
      const { host: harness } = await compositionFixture(t, 'npm-registration');
      const specification =
        registration === 'npm'
          ? await npmRegistration(t, harness.configRoot, harness.root)
          : process.platform === 'win32'
            ? './NODE_MODULES/@LUNCHBOX-LABS/OPENCODE-CONFIG-COMPOSER'
            : './node_modules/@lunchbox-labs/opencode-config-composer';
      const file = join(harness.configRoot, 'opencode.jsonc');
      const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...config, plugin: [specification] }));
      await writeFile(join(harness.configRoot, 'tui.jsonc'), JSON.stringify({ plugin: [specification] }));
      await harness.start();
      const skills = await harness.api<{ name: string; location: string }[]>('/skill');
      const commands = await harness.api<{ name: string }[]>('/command');
      for (const name of ['config-composer-create', 'config-composer-explain']) {
        const skill = skills.find((entry) => entry.name === name);
        assert.ok(skill !== undefined, `missing native skill ${name}: ${harness.stderr}`);
        assert.match(skill.location, /node_modules/);
        assert.ok(
          commands.some((entry) => entry.name === name),
          `missing slash command ${name}`,
        );
      }
      // Initialize the shared location before testing the TUI's bounded filesystem challenge.
      const shared = await fetch(`${harness.url}/config`, {
        headers: { 'x-opencode-directory': harness.configRoot },
        signal: AbortSignal.timeout(60_000),
      });
      assert.ok(shared.ok, await shared.text());
      // The terminal driver observes the session layout's input, rather than the centered home prompt.
      const session = await harness.api<{ id: string }>('/session', { title: 'Npm registration smoke' });
      const terminal = await nativeTerminal(harness, session.id, 'npm-registration');
      await terminal.wait(['ctrl+p', 'commands']);
      await terminal.command('/view-configs', 'Configuration', 'Shared groups', 'Profile definitions');
      await terminal.stop();
      assert.equal(harness.requests.length, 0, 'npm TUI startup must not send a model request');
      assert.doesNotMatch(harness.stderr, /incompatible|Failed to install|Failed to load/);
    },
  );
}
