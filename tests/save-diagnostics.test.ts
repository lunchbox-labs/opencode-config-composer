import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SettingsError } from '../src/config-composer/settings.ts';
import { changedInput } from '../src/config-composer/save-diagnostics.ts';
test('selection identity diagnostics bound paths and neutralize terminal controls', () => {
  const error = changedInput('Changed selection', '/tmp/\u001b' + 'x'.repeat(1000), 'identity');
  assert.ok(error instanceof SettingsError);
  assert.match(error.message, /^Changed selection\nObserved identity: \/tmp\/ /);
  assert.ok(error.message.endsWith('…'));
  assert.ok(error.message.length < 800);
  assert.equal(error.message.includes(String.fromCharCode(27)), false);
});
