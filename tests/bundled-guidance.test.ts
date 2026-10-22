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
test('bundled reload guidance distinguishes incomplete bootstrap and native normalization', async () => {
  const explain = await readFile(new URL('../skills/config-composer-explain/SKILL.md', import.meta.url), 'utf8');
  const schema = await readFile(
    new URL('../skills/config-composer-explain/references/schema.md', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(explain, /Native Markdown changes require a restart/);
  assert.match(schema, /incomplete.*attestation/i);
  assert.match(schema, /restart.*server/i);
  assert.match(schema, /normalize.*project JSON/i);
  assert.match(schema, /unexpected byte change.*unconfirmed/i);
  assert.doesNotMatch(schema, /No definition or native files are written by these commands/);
});
