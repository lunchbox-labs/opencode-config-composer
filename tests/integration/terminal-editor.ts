import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import type { compositionFixture } from './composition-fixture.ts';
import type { nativeTerminal } from './terminal.ts';

export async function reloadFromTerminal(
  fixture: Awaited<ReturnType<typeof compositionFixture>>,
  terminal: Awaited<ReturnType<typeof nativeTerminal>>,
) {
  await fixture.host.prepareConfigurationDependencies();
  const previous = JSON.stringify((await fixture.host.api<{ plugin: unknown[] }>('/config')).plugin);
  await terminal.choose('Reload now', 'Reload OpenCode settings?');
  await terminal.press('\r', 'Settings reloaded');
  // A previous toast can remain visible during another reload. Observe this
  // reload's new native registration before sending any request or more keys.
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = JSON.stringify((await fixture.host.api<{ plugin: unknown[] }>('/config')).plugin);
    if (current !== previous) {
      await fixture.host.api('/agent');
      return;
    }
    await setTimeout(50);
  }
  assert.fail('The terminal reload did not publish a new native registration');
}
