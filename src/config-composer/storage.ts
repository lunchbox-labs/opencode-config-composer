import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type CatalogModel, SettingsError, validateChoice } from './settings.ts';
import { type Source, loadSource } from './composition/sources.ts';
import {
  type SelectionSnapshot,
  readSelection,
  saveSelection,
  verifySelection,
  verifySelectionProof,
  withSelectionLock,
} from './composition/selection-state.ts';
import { type AttestedRuntime, type RuntimeLocation, readRuntimeContext } from './composition/runtime-baseline.ts';
import { type CompositionRevision, compositionRevision, digest, observeNative } from './composition/revision.ts';
import { resolveComposition } from './composition/runtime.ts';
import type { ResolvedCandidate, Selection } from './composition/document-types.ts';
export interface EditorConnection {
  location: RuntimeLocation;
  assertCurrent(): void;
  config(): Promise<unknown>;
  proveFilesystem(): Promise<void>;
}
export interface EditorContext {
  connection: EditorConnection;
  runtime: AttestedRuntime;
  source: Source;
  selection: SelectionSnapshot;
}
export interface Preview {
  choice: Selection;
  candidate: ResolvedCandidate;
  context: EditorContext;
}
export const metadataChanged = 'Native agent metadata changed. Restart OpenCode, then review again.';
export const jsonChanged =
  'Native JSON configuration changed. Restart OpenCode to refresh its global cache; instance apply cannot reload it. Saved changes are retained.';
export async function loadEditorContext(connection: EditorConnection): Promise<EditorContext> {
  connection.assertCurrent();
  await connection.proveFilesystem();
  const runtime = readRuntimeContext(await connection.config(), connection.location);
  await verifySelectionProof(runtime.selectionEnvironment);
  const source = await loadSource(runtime.options, runtime.configurationDirectory);
  const selection = await readSelection(runtime.selectionEnvironment, {
    root: runtime.location.root,
    baseFile: source.canonicalPath,
  });
  connection.assertCurrent();
  return { connection, runtime, source, selection };
}
async function verifyInputs(context: EditorContext): Promise<void> {
  const { connection, runtime, source, selection } = context;
  connection.assertCurrent();
  await verifySelectionProof(runtime.selectionEnvironment);
  const current = await loadSource(source.explicit ? { configFile: source.path } : {}, dirname(source.path));
  if (
    current.canonicalPath !== source.canonicalPath ||
    current.identity !== source.identity ||
    current.text !== source.text ||
    digest(current.document) !== digest(source.document)
  ) {
    throw new SettingsError('Composition source changed. Reopen the editor.');
  }
  await verifySelection(selection);
  let observed;
  try {
    observed = await observeNative(runtime.observation.context);
  } catch {
    throw new SettingsError(metadataChanged);
  }
  if (observed.metadata !== runtime.observation.metadata) {
    throw new SettingsError(metadataChanged);
  }
  if (observed.json !== runtime.observation.json) {
    throw new SettingsError(jsonChanged);
  }
  connection.assertCurrent();
}
export async function verifyContext(context: EditorContext, checkRuntime = true): Promise<void> {
  const { connection, runtime } = context;
  await verifyInputs(context);
  if (checkRuntime) {
    const currentRuntime = readRuntimeContext(await connection.config(), connection.location);
    if (
      currentRuntime.id !== runtime.id ||
      digest(currentRuntime.native) !== digest(runtime.native) ||
      digest(currentRuntime.observation) !== digest(runtime.observation)
    ) {
      throw new SettingsError('The running instance changed. Reopen the editor.');
    }
    // A runtime read can yield while local inputs change. Verify the reviewed
    // observations again before a caller may persist state or dispose the instance.
    await verifyInputs(context);
  }
  connection.assertCurrent();
}
export async function previewSelection(
  context: EditorContext,
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
    const models = await catalog();
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
  await verifyContext(context);
  return { choice, candidate, context };
}
export async function saveSelectionGuarded(context: EditorContext, preview: Preview): Promise<EditorContext> {
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
    const committed = await loadEditorContext(context.connection);
    if (
      !isDeepStrictEqual(committed.selection, persisted) ||
      !isDeepStrictEqual(committed.source, context.source) ||
      !isDeepStrictEqual(committed.runtime, context.runtime)
    ) {
      throw new SettingsError('Saved selection or reviewed inputs changed. Review again.');
    }
    await verifyContext({ ...context, selection: persisted });
    return committed;
  } catch (error) {
    throw new SettingsError(
      `Selection saved and pending. Could not reload committed context: ${error instanceof Error ? error.message : 'Reopen Config Composer.'}`,
      { cause: error },
    );
  }
}
export function expectedRevision(context: EditorContext): CompositionRevision {
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
  context: EditorContext,
  operation: (verify: (checkRuntime?: boolean) => Promise<void>) => Promise<T>,
): Promise<T> {
  return withSelectionLock(context.selection, async () => {
    await verifyContext(context);
    return operation((checkRuntime = true) => verifyContext(context, checkRuntime));
  });
}
