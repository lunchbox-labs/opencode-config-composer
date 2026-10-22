import { isDeepStrictEqual } from 'node:util';
import { RestartRequiredError, SettingsError } from '../settings.ts';
import { type ConfigurationContext, expectedRevision, verifySavedInputs, withSavedContext } from '../storage.ts';
import { type RuntimeMarker, readRuntimeContext } from './runtime-baseline.ts';
import { type CompositionRevision, compositionRevision, digest, observeNative } from './revision.ts';
import { resolveComposition } from './runtime.ts';
import { withSelectionLock } from './selection-state.ts';
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
      'Reload is not confirmed: a new Composer registration was not ready. Configuration remains pending; inspect or retry.',
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

/** Reload reviewed disk inputs through the scoped host lifecycle. Idle checks are
 * best effort: the host does not expose an atomic activity reservation/disposal. */
export async function reloadSavedConfiguration(
  context: ConfigurationContext,
  port: ApplyPort,
): Promise<CompositionRevision> {
  const verify = async (checkRuntime: boolean) => {
    port.assertCurrent();
    await verifySavedInputs(context);
    const disk = await observeNative(context.disk.context);
    if (context.runtime.globalJsonBaseline === undefined || disk.globalJson !== context.runtime.globalJsonBaseline) {
      throw new RestartRequiredError(
        'Native global JSON changed or its cache baseline is unavailable. Restart the OpenCode server process, then review again.',
      );
    }
    if (!isDeepStrictEqual(disk, context.disk)) {
      throw new SettingsError('Native inputs changed during reload. Review /view-configs and retry.');
    }
    if (checkRuntime) {
      const current = readRuntimeContext(await context.connection.config(), context.connection.location);
      if (current.id !== context.runtime.id) {
        throw new SettingsError('The running instance changed. Review again.');
      }
      await verify(false);
    }
    port.assertCurrent();
  };
  return withSelectionLock(context.selection, async () => {
    await verify(true);
    // Catch a removed saved profile before teardown; native targets are validated
    // against the fresh native baseline only after registration.
    const choice =
      context.selection.choice === undefined ? context.source.document.defaultProfile : context.selection.choice;
    if (choice !== undefined && choice !== null && !Object.hasOwn(context.source.document.profiles, choice)) {
      throw new SettingsError(`Saved profile ${choice} does not exist. Choose a valid profile with /profiles.`);
    }
    const activity = await port.activity();
    if (Object.values(activity).some((status) => status.type !== 'idle')) {
      throw new SettingsError(
        'Agents are still running in this instance. Configuration remains pending; retry reload when idle.',
      );
    }
    await verify(true);
    await port.dispose();
    port.assertCurrent();
    const current = await newRegistration(context.runtime.id, port);
    const confirmed = readRuntimeContext(await context.connection.config(), context.connection.location);
    await verify(false);
    if (confirmed.status !== 'applied' || current.status !== 'applied') {
      throw new SettingsError(
        confirmed.diagnostic ?? current.diagnostic ?? 'Composer reload failed; configuration remains pending.',
      );
    }
    const expected = compositionRevision(
      context.source,
      context.selection,
      resolveComposition(
        context.source.document,
        context.selection.choice,
        confirmed.native,
        confirmed.observation.authority,
      ),
    );
    if (
      confirmed.id !== current.id ||
      !isDeepStrictEqual(confirmed.observation, context.disk) ||
      confirmed.globalJsonBaseline !== context.runtime.globalJsonBaseline ||
      !isDeepStrictEqual(confirmed.source, {
        path: context.source.path,
        canonicalPath: context.source.canonicalPath,
        fingerprint: digest(context.source.text ?? null),
      }) ||
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
      !isDeepStrictEqual(confirmed.revision, expected)
    ) {
      throw new SettingsError(
        confirmed.diagnostic ??
          'Reload is not confirmed: the server did not apply the reviewed configuration. Inspect pending inputs and retry.',
      );
    }
    port.assertCurrent();
    return expected;
  });
}
