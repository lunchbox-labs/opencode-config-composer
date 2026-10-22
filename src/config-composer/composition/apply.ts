import { isDeepStrictEqual } from 'node:util';
import { SettingsError } from '../settings.ts';
import { type ConfigurationContext, expectedRevision, withSavedContext } from '../storage.ts';
import { type RuntimeMarker, readRuntimeContext } from './runtime-baseline.ts';
import type { CompositionRevision } from './revision.ts';
export interface ApplyPort {
  assertCurrent(): void;
  activity(): Promise<Record<string, { type: string }>>;
  dispose(): Promise<void>;
  refresh(): Promise<RuntimeMarker>;
}
async function newRegistration(previous: string, port: ApplyPort): Promise<RuntimeMarker> {
  let current: RuntimeMarker | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    port.assertCurrent();
    try {
      current = await port.refresh();
    } catch (error) {
      if (!(error instanceof SettingsError) || !error.message.startsWith('No runtime marker.')) {
        throw error;
      }
    }
    port.assertCurrent();
    if (current !== undefined && current.id !== previous) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (current === undefined || current.id === previous) {
    throw new SettingsError(
      'Profile application is not confirmed: a new Composer registration was not ready. Configuration remains pending; inspect or retry.',
    );
  }
  return current;
}
export async function applySavedComposition(
  context: ConfigurationContext,
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
    const current = await newRegistration(previous.id, port);
    port.assertCurrent();
    const confirmed = readRuntimeContext(await context.connection.config(), context.connection.location);
    port.assertCurrent();
    await verify(false);
    if (
      current.id === previous.id ||
      confirmed.id !== current.id ||
      current.status !== 'applied' ||
      confirmed.status !== 'applied' ||
      confirmed.definitionId !== context.runtime.definitionId ||
      !isDeepStrictEqual(confirmed.source, context.runtime.source) ||
      !isDeepStrictEqual(confirmed.selectionLocator, context.runtime.selectionLocator) ||
      !isDeepStrictEqual(
        confirmed.selection,
        JSON.parse(
          JSON.stringify({
            path: context.selection.path,
            choice: context.selection.choice,
            revision: context.selection.revision,
            identity: context.selection.identity,
          }),
        ),
      ) ||
      !isDeepStrictEqual(confirmed.revision, expected) ||
      !isDeepStrictEqual(confirmed.observation, previous.observation)
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
