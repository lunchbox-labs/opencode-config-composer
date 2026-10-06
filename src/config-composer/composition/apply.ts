import { isDeepStrictEqual } from 'node:util';
import { SettingsError } from '../settings.ts';
import { type Snapshot, withSavedSnapshot } from '../storage.ts';
import { type CompositionRevision, compositionRevision, observeNativeFiles } from './revision.ts';
import type { readRuntimeRevision } from './runtime-baseline.ts';

export type AppliedRuntime = ReturnType<typeof readRuntimeRevision>;
export interface ApplyPort {
  assertCurrent(): void;
  activity: () => Promise<Record<string, { type: string }>>;
  dispose(): Promise<void>;
  /** Refresh config, provider and agent state before returning the validated runtime attestation. */
  refresh(): Promise<AppliedRuntime>;
}
export interface ApplyFailure {
  phase: 'save-failed' | 'apply-failed';
  message: string;
}
export function applyStatus(saved: CompositionRevision, runtime: AppliedRuntime, failure?: ApplyFailure): string {
  if (failure !== undefined) {
    return `${failure.phase === 'save-failed' ? 'Save failed' : 'Apply failed'}: ${failure.message}`;
  }
  return isDeepStrictEqual(saved, runtime.revision)
    ? `Composer revision ${saved.sources.slice(0, 12)} applied against the running native baseline`
    : `Saved Composer revision ${saved.sources.slice(0, 12)} is pending; ${runtime.revision === undefined ? 'no valid applied revision' : `applied ${runtime.revision.sources.slice(0, 12)}`}`;
}

export async function applySavedComposition(
  snapshot: Snapshot,
  previous: AppliedRuntime,
  port: ApplyPort,
): Promise<CompositionRevision> {
  const expected = compositionRevision(snapshot.sources, snapshot.resolved, snapshot.files);
  port.assertCurrent();
  if ((await observeNativeFiles(snapshot.root)) !== previous.observedNativeFiles) {
    throw new SettingsError(
      'Native JSON configuration changed. Restart OpenCode to refresh its global cache; instance apply cannot reload it. Saved changes are retained.',
    );
  }
  const result = await withSavedSnapshot(snapshot, async (verify) => {
    // The public API has no conditional dispose transaction. Check activity at the final asynchronous boundary.
    const activity = await port.activity();
    if (Object.values(activity).some((status) => status.type !== 'idle')) {
      throw new SettingsError('Agents are still running in this instance. Settings are saved; retry apply when idle.');
    }
    port.assertCurrent();
    await port.dispose();
    port.assertCurrent();
    const current = await port.refresh();
    port.assertCurrent();
    await verify();
    if (
      current.id === previous.id ||
      !isDeepStrictEqual(current.revision, expected) ||
      current.observedNativeFiles !== previous.observedNativeFiles
    ) {
      throw new SettingsError(
        'The server did not confirm the requested applied revision after rebootstrap. Saved changes are retained; retry or restart OpenCode.',
      );
    }
    return expected;
  });
  port.assertCurrent();
  return result;
}
