import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { EventTuiToastShow, GlobalEvent } from '@opencode-ai/sdk';
import type { nativeHarness } from './harness.ts';

export type NativeToast = EventTuiToastShow['properties'] & { directory: string };

/** Observe actual native TUI delivery without substituting the notification client. */
export async function nativeNotifications(
  host: Awaited<ReturnType<typeof nativeHarness>>,
  name = 'canonical-permission-notifications',
) {
  const controller = new AbortController();
  const response = await fetch(`${host.url}/global/event`, { signal: controller.signal });
  assert.ok(response.ok && response.body !== null);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toasts: NativeToast[] = [];
  let pending = '';
  let failure: unknown;
  const collecting = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      pending += decoder.decode(chunk.value, { stream: true });
      assert.ok(pending.length < 1_000_000, 'native event frame exceeds the fixture limit');
      let end: number;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5))
          .join('\n');
        if (data === '') {
          continue;
        }
        const event = JSON.parse(data) as GlobalEvent;
        if (
          event.payload.type === 'tui.toast.show' &&
          event.payload.properties.title === 'Config Composer permissions'
        ) {
          toasts.push({ ...event.payload.properties, directory: event.directory });
          assert.ok(toasts.length <= 200, 'unexpected native permission notification loop');
        }
      }
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) {
      failure = error;
    }
  });
  host.beforeStop(async () => {
    controller.abort();
    await collecting;
    const directory = process.env.INTEGRATION_ARTIFACT_DIR;
    if (directory !== undefined) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${name}.json`), Buffer.from(JSON.stringify(toasts, null, 2)).subarray(-65_536));
    }
    assert.equal(failure, undefined, 'native notification subscription failed');
  });
  const wait = async (predicate: (toast: NativeToast) => boolean, after = 0) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      assert.equal(failure, undefined, 'native notification subscription failed');
      const found = toasts.slice(after).find(predicate);
      if (found !== undefined) {
        return found;
      }
      await setTimeout(50);
    }
    assert.fail(`Expected native permission notification; received ${JSON.stringify(toasts.slice(after))}`);
  };
  return { toasts, wait };
}
