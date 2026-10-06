import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permissionReview } from '../src/config-composer/tui/permission-review.ts';

test('confirmation risk comes first and many failed scopes share a bounded summary', () => {
  const scopes = Array.from({ length: 256 }, (_, index) => ({
    scope: `agent:worker-${index}`,
    message: 'Full diagnostic',
  }));
  const message = permissionReview([{ scope: 'global', message: 'Global diagnostic' }, ...scopes]);
  assert.match(message, /^Fallback may be more permissive, including missing intended deny rules\./);
  assert.match(message, /Global scope: Composer global permissions were not applied/);
  assert.match(message, /Agent worker-0:/);
  assert.match(message, /250 additional agent scopes/);
  assert.ok(message.length < 700);
  assert.equal(permissionReview([]), '');
  assert.ok(permissionReview([{ scope: `agent:${'long'.repeat(100)}`, message: '' }]).length < 400);
});
