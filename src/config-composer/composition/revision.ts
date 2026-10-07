import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { configurationDirectory, configurationFile } from '../configuration.ts';
import { SettingsError, record } from '../settings.ts';
import { type SourceFile, collectFileReads } from '../storage.ts';
import type { LoadedSources } from './sources.ts';
import type { ResolvedProfileRuntime } from './runtime.ts';

export interface CompositionRevision {
  sources: string;
  effective: string;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = async (path: string) =>
  realpath(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });

function componentPaths(sources: LoadedSources): Set<string> {
  const paths = new Set<string>();
  const registries: unknown[] = Object.values(sources.registry.components ?? {});
  for (const entries of registries) {
    if (!record(entries)) {
      continue;
    }
    for (const value of Object.values(entries)) {
      if (record(value) && typeof value.file === 'string') {
        paths.add(value.file);
      }
    }
  }
  return paths;
}

/** Freeze the explicit component inputs used by this resolution, including currently inactive definitions. */
export async function captureCompositionInputs(sources: LoadedSources): Promise<SourceFile[]> {
  const result: SourceFile[] = [];
  for (const path of componentPaths(sources)) {
    const canonicalPath = await realpath(path);
    result.push({ ...(await configurationFile(canonicalPath)), path, canonicalPath });
  }
  return result;
}

/** Attest Composer inputs and their result against the running native baseline, not the freshness of native JSON. */
export function compositionRevision(
  sources: LoadedSources,
  resolved: ResolvedProfileRuntime,
  files: readonly SourceFile[],
): CompositionRevision {
  const components = componentPaths(sources);
  const inputs = new Map<string, unknown>();
  for (const file of collectFileReads(files).files) {
    if (
      ![file.path, ...(file.aliases ?? [])].some((path) => components.has(path)) &&
      (file.directories?.length ?? 0) === 0
    ) {
      continue;
    }
    const value = [
      file.canonicalPath ?? file.path,
      digest(file.text),
      [...(file.directories ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
    ];
    for (const path of new Set([
      ...[file.path, ...(file.aliases ?? [])].filter((path) => components.has(path)),
      ...(file.includePaths ?? []),
    ])) {
      inputs.set(path, value);
    }
  }
  for (const path of components) {
    if (!inputs.has(path)) {
      throw new SettingsError(`Composition input ${path} was not captured. Reopen the editor.`);
    }
  }
  return {
    sources: digest({
      paths: [...sources.paths].sort(([a], [b]) => a.localeCompare(b)),
      documents: sources.documents.map((source) => [source.id, source.fingerprint]),
      scopes: sources.scopes.map((scope) => scope.id),
      activeProfiles: sources.activeProfiles,
      inputs: [...inputs].sort(([a], [b]) => a.localeCompare(b)),
    }),
    effective: digest({
      default_agent: resolved.default_agent,
      model: resolved.model,
      small_model: resolved.small_model,
      permission: resolved.permission,
      agent: resolved.agent,
      commands: resolved.commands,
      skillPaths: resolved.skillPaths,
      choices: resolved.choices,
    }),
  };
}

/** Check the captured bytes and identities again before publishing or applying a revision. */
export async function verifyCompositionInputs(sources: LoadedSources, files: readonly SourceFile[]): Promise<void> {
  for (const [path, expected] of sources.paths) {
    if ((await identity(path)) !== expected) {
      throw new SettingsError('Composition source identity changed. Reopen the editor.');
    }
  }
  const documents = sources.documents.map((source) => ({
    path: source.path,
    canonicalPath: source.id,
    text: source.text,
  }));
  for (const file of [...documents, ...files]) {
    const canonical = file.canonicalPath ?? file.path;
    if ((await identity(file.path)) !== canonical || (await configurationFile(canonical)).text !== file.text) {
      throw new SettingsError('Composition inputs changed. Reopen the editor before applying.');
    }
    if ('aliases' in file) {
      for (const path of file.aliases ?? []) {
        if ((await identity(path)) !== canonical) {
          throw new SettingsError('Composition input identity changed. Reopen the editor.');
        }
      }
    }
    if ('directories' in file) {
      for (const directory of file.directories ?? []) {
        if ((await identity(directory.path)) !== directory.canonicalPath) {
          throw new SettingsError('A prompt source directory changed. Reopen the editor.');
        }
      }
    }
  }
}

/** Observe disk bytes as a change guard only; the host exposes no fingerprint of its cached native inputs.
 * A new instance can observe new bytes while inheriting old cached native values. Native JSON edits require restart.
 */
export async function observeNativeFiles(directory = configurationDirectory()): Promise<string> {
  const inputs: unknown[] = [];
  for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) {
    const path = join(directory, name);
    const canonical = await identity(path);
    inputs.push([path, canonical ?? null, canonical === undefined ? null : (await configurationFile(canonical)).text]);
  }
  return digest(inputs);
}
