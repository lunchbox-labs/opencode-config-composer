import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import type { compositionFixture } from './composition-fixture.ts';
import type { nativeTerminal } from './terminal.ts';

export async function reloadFromTerminal(
  fixture: Awaited<ReturnType<typeof compositionFixture>>,
  terminal: Awaited<ReturnType<typeof nativeTerminal>>,
) {
  await fixture.host.prepareConfigurationDependencies();
  const previous = await fixture.editor.runtime();
  await terminal.choose(
    'Reload now',
    'Apply saved revision?',
    'only this instance',
    'cannot reset',
    '/models',
    '/variants',
    'Default',
  );
  await terminal.press('\r', 'Composer revision applied');
  // A previous toast can remain visible during another reload. Observe this
  // reload's new native registration before sending any request or more keys.
  let pendingRegistration: Error | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = await fixture.editor.runtime().catch((error: unknown) => {
      // An unpublished sample is not yet a usable registration after disposal.
      // Retry only this baseline diagnostic, within the existing readiness bound.
      // Persistent missing/ambiguous metadata still fails with its original cause;
      // transport failures and changed/invalid configuration fail immediately.
      if (
        !(error instanceof Error) ||
        error.message !==
          'The runtime baseline version is missing or ambiguous. Exact native baseline is unavailable. Reload the matching Config Composer server plugin and reopen the editor.'
      ) {
        throw error;
      }
      pendingRegistration = error;
      return undefined;
    });
    if (current !== undefined && current.applied.id !== previous.applied.id) {
      await fixture.host.api('/agent');
      assert.deepEqual(current.baseline, previous.baseline, 'scoped apply retains the native baseline');
      return;
    }
    await setTimeout(50);
  }
  throw new Error('The terminal reload did not publish a new native registration', { cause: pendingRegistration });
}
