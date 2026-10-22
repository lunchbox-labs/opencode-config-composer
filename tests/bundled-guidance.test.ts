import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateBundledSkills } from '../src/config-composer/bundled-skills.ts';
test('bundled guidance is loadable and describes the shipped one-profile contract', async () => {
  await validateBundledSkills();
  for (const path of [
    '../README.md',
    '../skills/config-composer-create/SKILL.md',
    '../skills/config-composer-explain/SKILL.md',
    '../skills/config-composer-explain/references/schema.md',
  ]) {
    const text = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(text, /view-configs/);
    assert.doesNotMatch(
      text,
      /activeProfiles|configurationPresets|componentGroups|agent-models|compose-configs|profileShortcuts/,
    );
  }
});
test('bundled guidance describes loaded definitions and separate live selection', async () => {
  for (const path of [
    '../README.md',
    '../skills/config-composer-create/SKILL.md',
    '../skills/config-composer-explain/SKILL.md',
    '../skills/config-composer-explain/references/schema.md',
  ]) {
    const text = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /reload-configs/);
    assert.match(text, /loaded/i);
    assert.match(text, /restart.*server/i);
    assert.match(text, /selection|choice/i);
  }
});
