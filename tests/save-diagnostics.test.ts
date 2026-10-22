import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedInput } from '../src/config-composer/save-diagnostics.ts';
test('selection identity diagnostics bound paths and neutralize terminal controls', () => {
  const error = changedInput('Changed selection', '/tmp/\u001b' + 'x'.repeat(1000), 'identity');
  assert.equal(error.details.input?.category, 'identity');
  assert.ok(error.message.length < 800);
  assert.equal(error.message.includes(String.fromCharCode(27)), false);
});
