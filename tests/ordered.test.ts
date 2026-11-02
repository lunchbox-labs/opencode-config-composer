import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allInOrder } from '../src/config-composer/ordered.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('allInOrder resolves values in argument order', async () => {
  assert.deepEqual(await allInOrder([delay(20).then(() => 'slow'), Promise.resolve('fast'), undefined]), [
    'slow',
    'fast',
    undefined,
  ]);
});

test('allInOrder reports the earliest failure in argument order after every operation settles', async () => {
  let settled = false;
  const earlier = delay(20).then(() => {
    throw new Error('earlier');
  });
  const later = Promise.reject(new Error('later'));
  const pending = delay(40).then(() => {
    settled = true;
  });
  await assert.rejects(allInOrder([Promise.resolve(), earlier, later, pending]), /^Error: earlier$/);
  assert.equal(settled, true);
});
