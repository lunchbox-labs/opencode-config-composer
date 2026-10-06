import { join } from 'node:path';
import { SettingsError } from '../settings.ts';
import { type FilePlan, type Snapshot, type SourceFile, editJson } from '../storage.ts';

export type CompositionScope = 'shared' | 'project' | 'local';
export type ScopeChange = { operation: 'create' } | { operation: 'selection'; profiles?: string[] };
export interface ScopeDestination {
  scope: CompositionScope;
  path: string;
  file?: SourceFile;
  selection?: string[];
  inherited: string[];
  maskedBy?: CompositionScope;
  writable: boolean;
}

export function scopeDestinations(snapshot: Snapshot): ScopeDestination[] {
  const paths = [
    ['shared', snapshot.sourceContext.baseFile ?? join(snapshot.root, 'config-composer.jsonc')],
    ['project', join(snapshot.sourceContext.root, '.opencode/config-composer.jsonc')],
    ['local', join(snapshot.sourceContext.root, '.opencode/config-composer.local.jsonc')],
  ] as const;
  let inherited: string[] = [];
  const result: ScopeDestination[] = [];
  for (const [index, [scope, path]] of paths.entries()) {
    // One physical document can occupy several scope slots; expose its highest-precedence slot once.
    const canonical = snapshot.sources.paths.get(path) ?? path;
    if (paths.slice(index + 1).some(([, other]) => (snapshot.sources.paths.get(other) ?? other) === canonical)) {
      continue;
    }
    const file = snapshot.files.find((file) => file.path === canonical);
    const source = snapshot.sources.scopes.find((source) => source.id === canonical);
    const selection = source?.value.activeProfiles;
    result.push({
      scope,
      path,
      file,
      selection,
      inherited: [...inherited],
      writable:
        file === undefined
          ? scope === 'shared'
            ? path === join(snapshot.root, 'config-composer.jsonc')
            : snapshot.sourceContext.root === snapshot.scopeRoot
          : file.writable !== false && file.path === path,
    });
    if (selection !== undefined) {
      inherited = [...selection];
    }
  }
  for (const [index, destination] of result.entries()) {
    destination.maskedBy = result.slice(index + 1).findLast((later) => later.selection !== undefined)?.scope;
  }
  return result;
}

export function planScope(snapshot: Snapshot, scope: CompositionScope, change: ScopeChange): FilePlan {
  const destination = scopeDestinations(snapshot).find((item) => item.scope === scope);
  if (destination?.writable !== true) {
    throw new SettingsError(
      'That composition scope is read-only or aliases a later scope. Select its declaring source.',
    );
  }
  if (change.operation === 'create' && destination.file !== undefined) {
    throw new SettingsError('That composition source already exists. Reopen the editor.');
  }
  const file = destination.file ?? {
    path: destination.path,
    text: '',
    mode: 0o600,
    writable: true,
    writeRoot: scope === 'shared' ? snapshot.root : snapshot.scopeRoot,
  };
  const text =
    change.operation === 'create'
      ? '{}\n'
      : editJson(file.text === '' ? '{}\n' : file.text, ['activeProfiles'], change.profiles);
  const inheritAbsent =
    destination.file === undefined && change.operation === 'selection' && change.profiles === undefined;
  return {
    snapshot,
    edits:
      inheritAbsent || text === file.text
        ? []
        : [{ file, text, ...(destination.file === undefined ? { create: true } : {}) }],
    description:
      change.operation === 'create'
        ? `Create ${scope} composition source`
        : `${scope} profile selection: ${change.profiles === undefined ? 'inherit' : change.profiles.length === 0 ? 'none' : change.profiles.join(' → ')}`,
  };
}
