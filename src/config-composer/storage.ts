import { isDeepStrictEqual } from 'node:util';
import { type CatalogModel, SettingsError, validateChoice } from './settings.ts';
import type { LoadedSource } from './composition/sources.ts';
import {
  type SelectionSnapshot,
  readSelectionAt,
  saveSelection,
  verifySelectionProof,
  withSelectionLock,
} from './composition/selection-state.ts';
import { type AttestedRuntime, type RuntimeLocation, readRuntimeContext } from './composition/runtime-baseline.ts';
import { type CompositionRevision, compositionRevision, digest, observeNative } from './composition/revision.ts';
import { resolveComposition } from './composition/runtime.ts';
import type { ResolvedCandidate, Selection } from './composition/document-types.ts';
export interface ConfigurationConnection {
  location: RuntimeLocation;
  assertCurrent(): void;
  config(): Promise<unknown>;
  proveFilesystem(): Promise<void>;
}
export interface ConfigurationContext {
  connection: ConfigurationConnection;
  runtime: AttestedRuntime;
  source: LoadedSource;
  selection: SelectionSnapshot;
}
export interface Preview {
  choice: Selection;
  candidate: ResolvedCandidate;
  context: ConfigurationContext;
}
export const metadataChanged = 'Native agent metadata changed. Restart the OpenCode server process, then review again.';
export const jsonChanged = 'Native JSON configuration changed. Restart the OpenCode server process, then review again.';
export async function loadConfigurationContext(connection: ConfigurationConnection): Promise<ConfigurationContext> {
  connection.assertCurrent();
  const runtime = readRuntimeContext(await connection.config(), connection.location);
  await verifySelectionProof(runtime.selectionEnvironment);
  const source = runtime.source;
  const selection = await readSelectionAt(runtime.selectionEnvironment, runtime.selectionLocator);
  connection.assertCurrent();
  return { connection, runtime, source, selection };
}
async function verifySavedInputs(context: ConfigurationContext): Promise<void> {
  const { connection, runtime, selection } = context;
  connection.assertCurrent();
  await verifySelectionProof(runtime.selectionEnvironment);
  const current = await readSelectionAt(runtime.selectionEnvironment, runtime.selectionLocator);
  if (!isDeepStrictEqual(current, selection)) {
    throw new SettingsError('Profile selection changed. Reopen Config Composer.');
  }
  connection.assertCurrent();
}
async function verifyInputs(context: ConfigurationContext): Promise<void> {
  await verifySavedInputs(context);
  const { connection, runtime } = context;
  await connection.proveFilesystem();
  let observed;
  try {
    observed = await observeNative(runtime.observation.context);
  } catch {
    throw new SettingsError(metadataChanged);
  }
  if (observed.globalJson !== runtime.globalJsonBaseline) {
    throw new SettingsError('Native global JSON changed. Restart the OpenCode server process, then review again.');
  }
  if (observed.metadata !== runtime.observation.metadata) {
    throw new SettingsError(metadataChanged);
  }
  if (observed.json !== runtime.observation.json) {
    throw new SettingsError(jsonChanged);
  }
  if (observed.commands !== runtime.observation.commands) {
    throw new SettingsError('Native command Markdown changed. Restart the OpenCode server process, then review again.');
  }
  connection.assertCurrent();
}
export async function verifyContext(context: ConfigurationContext, checkRuntime = true): Promise<void> {
  const { connection, runtime } = context;
  await verifyInputs(context);
  if (checkRuntime) {
    const currentRuntime = readRuntimeContext(await connection.config(), connection.location);
    if (
      currentRuntime.id !== runtime.id ||
      currentRuntime.definitionId !== runtime.definitionId ||
      !isDeepStrictEqual(currentRuntime.source, runtime.source) ||
      !isDeepStrictEqual(currentRuntime.selectionLocator, runtime.selectionLocator) ||
      digest(currentRuntime.native) !== digest(runtime.native) ||
      digest(currentRuntime.observation) !== digest(runtime.observation)
    ) {
      throw new SettingsError('The running instance changed. Reopen Config Composer.');
    }
    // A runtime read can yield while local inputs change. Verify the reviewed
    // observations again before a caller may persist state or dispose the instance.
    await verifyInputs(context);
  }
  connection.assertCurrent();
}
function validateCandidate(candidate: ResolvedCandidate, models: CatalogModel[]): void {
  for (const model of [candidate.model, candidate.small_model]) {
    if (model !== undefined) {
      validateChoice({ model }, models);
    }
  }
  for (const agent of Object.values(candidate.agent)) {
    const model = typeof agent.model === 'string' && agent.model !== '' ? agent.model : candidate.model;
    validateChoice({ model, variant: typeof agent.variant === 'string' ? agent.variant : undefined }, models);
  }
  for (const command of Object.values(candidate.command)) {
    if (typeof command.model === 'string') {
      validateChoice({ model: command.model }, models);
    }
  }
}

export async function previewSelection(
  context: ConfigurationContext,
  choice: Selection,
  catalog?: () => Promise<CatalogModel[]>,
): Promise<Preview> {
  await verifyContext(context);
  const candidate = resolveComposition(
    context.source.document,
    choice,
    context.runtime.native,
    context.runtime.observation.authority,
  );
  if (catalog !== undefined) {
    validateCandidate(candidate, await catalog());
  }
  await verifyContext(context);
  return { choice, candidate, context };
}
export async function saveSelectionGuarded(
  context: ConfigurationContext,
  preview: Preview,
): Promise<ConfigurationContext> {
  if (
    preview.context !== context ||
    digest(
      resolveComposition(
        context.source.document,
        preview.choice,
        context.runtime.native,
        context.runtime.observation.authority,
      ),
    ) !== digest(preview.candidate)
  ) {
    throw new SettingsError('Preview does not match the attested context. Review again.');
  }
  const persisted = await saveSelection(context.selection, preview.choice, () => verifyContext(context));
  try {
    const committed = await loadConfigurationContext(context.connection);
    if (
      !isDeepStrictEqual(committed.selection, persisted) ||
      committed.runtime.definitionId !== context.runtime.definitionId ||
      !isDeepStrictEqual(committed.runtime.selectionLocator, context.runtime.selectionLocator) ||
      !isDeepStrictEqual(committed.runtime, context.runtime)
    ) {
      throw new SettingsError('Saved selection or reviewed inputs changed. Review again.');
    }
    await verifyContext({ ...context, selection: persisted });
    return committed;
  } catch (error) {
    throw new SettingsError(
      `Selection saved and pending. Could not confirm committed context: ${error instanceof Error ? error.message : 'Reopen Config Composer.'}`,
      { cause: error },
    );
  }
}
export function expectedRevision(context: ConfigurationContext): CompositionRevision {
  return compositionRevision(
    context.source,
    context.selection,
    resolveComposition(
      context.source.document,
      context.selection.choice,
      context.runtime.native,
      context.runtime.observation.authority,
    ),
  );
}
export async function withSavedContext<T>(
  context: ConfigurationContext,
  operation: (verify: (checkRuntime?: boolean) => Promise<void>) => Promise<T>,
): Promise<T> {
  return withSelectionLock(context.selection, async () => {
    await verifyContext(context);
    return operation((checkRuntime = true) => verifyContext(context, checkRuntime));
  });
}
