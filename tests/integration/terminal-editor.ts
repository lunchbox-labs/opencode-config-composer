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
    'Existing session model selections remain',
  );
  await terminal.press('\r', 'Composer revision applied');
  // A previous toast can remain visible during another reload. Observe this
  // reload's new native registration before sending any request or more keys.
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = await fixture.editor.runtime();
    if (current.applied.id !== previous.applied.id) {
      await fixture.host.api('/agent');
      assert.deepEqual(current.baseline, previous.baseline, 'scoped apply retains the native baseline');
      return;
    }
    await setTimeout(50);
  }
  assert.fail('The terminal reload did not publish a new native registration');
}
