import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { npmRegistration } from './npm-registration.ts';
import { nativeHarness } from './integration/harness.ts';

test(
  'native npm registration discovers packaged Composer skills and slash commands',
  { timeout: 180_000 },
  async (t) => {
    const harness = await nativeHarness(t, 'npm-registration');
    const specification = await npmRegistration(t, harness.configRoot);
    await writeFile(join(harness.project, 'opencode.json'), JSON.stringify({ plugin: [specification] }));
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
    assert.doesNotMatch(harness.stderr, /incompatible|Failed to install|Failed to load/);
  },
);
