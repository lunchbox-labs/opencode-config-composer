import assert from 'node:assert/strict';
import timers from 'node:timers/promises';
import type { compositionFixture } from './composition-fixture.ts';
import type { nativeTerminal } from './terminal.ts';
/** A longer preview scrolls before its separate Apply confirmation. */
const reviewAction = 'enter apply…';
export async function applyFromTerminal(
  fixture: Awaited<ReturnType<typeof compositionFixture>>,
  terminal: Awaited<ReturnType<typeof nativeTerminal>>,
) {
  await fixture.host.prepareConfigurationDependencies();
  const previous = await fixture.editor.runtime();
  if (terminal.shows(reviewAction)) {
    await terminal.press('\r', 'Apply reviewed changes?');
  }
  await terminal.press('\r', 'Composer revision applied');
  let pending: Error | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = await fixture.editor.runtime().catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.startsWith('No runtime marker.')) {
        throw error;
      }
      pending = error;
      return undefined;
    });
    if (current !== undefined && current.id !== previous.id) {
      await fixture.host.api('/agent');
      assert.deepEqual(current.native, previous.native, 'scoped apply retains the native baseline');
      return;
    }
    await timers.setTimeout(50);
  }
  throw new Error('The terminal profile apply did not publish a new native registration', { cause: pending });
}

export async function readPreview(terminal: Awaited<ReturnType<typeof nativeTerminal>>): Promise<string> {
  return terminal.shows(reviewAction)
    ? terminal.scrollTo('Existing session model/variant choices remain native.')
    : terminal.text();
}
