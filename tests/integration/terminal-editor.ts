import assert from 'node:assert/strict';
import timers from 'node:timers/promises';
import type { compositionFixture } from './composition-fixture.ts';
import type { nativeTerminal } from './terminal.ts';
export async function applyFromTerminal(
  fixture: Awaited<ReturnType<typeof compositionFixture>>,
  terminal: Awaited<ReturnType<typeof nativeTerminal>>,
  notice: string,
) {
  await fixture.host.prepareConfigurationDependencies();
  const previous = await fixture.editor.runtime();
  if (terminal.text().includes('Review page')) {
    await terminal.choose('Apply', 'Apply reviewed changes?');
  }
  await terminal.press('\r', 'Config Composer', notice);
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

export async function readPreview(
  terminal: Awaited<ReturnType<typeof nativeTerminal>>,
  title: string,
): Promise<string> {
  const match = /Review page \d+ of (\d+)/.exec(terminal.text());
  if (match === null) {
    return terminal.text();
  }
  const pages = Number(match[1]);
  let text = '';
  for (let page = 1; page <= pages; page++) {
    await terminal.choose(`Review page ${page} of ${pages}`, `Preview · ${page}/${pages}`);
    text += terminal.text();
    await terminal.press('\x1b', title);
  }
  return text;
}
