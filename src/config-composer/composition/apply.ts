import { isDeepStrictEqual } from 'node:util';
import { SettingsError } from '../settings.ts';
import { type EditorContext, expectedRevision, withSavedContext } from '../storage.ts';
import { type RuntimeMarker, readRuntimeContext } from './runtime-baseline.ts';
import type { CompositionRevision } from './revision.ts';
export interface ApplyPort {
  assertCurrent(): void;
  activity(): Promise<Record<string, { type: string }>>;
  dispose(): Promise<void>;
  refresh(): Promise<RuntimeMarker>;
}
export async function applySavedComposition(
  context: EditorContext,
  previous: RuntimeMarker,
  port: ApplyPort,
): Promise<CompositionRevision> {
  const expected = expectedRevision(context);
  port.assertCurrent();
  const applied = await withSavedContext(context, async (verify) => {
    const activity = await port.activity();
    if (Object.values(activity).some((status) => status.type !== 'idle')) {
      throw new SettingsError('Agents are still running in this instance. Settings are saved; retry apply when idle.');
    }
    await verify();
    port.assertCurrent();
    await port.dispose();
    port.assertCurrent();
    const current = await port.refresh();
    port.assertCurrent();
    const confirmed = readRuntimeContext(await context.connection.config(), context.connection.location);
    port.assertCurrent();
    await verify(false);
    if (
      current.id === previous.id ||
      confirmed.id !== current.id ||
      current.status !== 'applied' ||
      !isDeepStrictEqual(current.revision, expected) ||
      !isDeepStrictEqual(current.observation, previous.observation)
    ) {
      throw new SettingsError(
        'The server did not confirm the requested applied revision. Settings are saved and pending; retry or restart OpenCode.',
      );
    }
    return expected;
  });
  port.assertCurrent();
  return applied;
}
