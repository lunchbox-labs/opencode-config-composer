import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { configurationDirectory, configurationFile, configurationPath, parseConfiguration } from '../configuration.ts';
import { SettingsError, record } from '../settings.ts';
import type { SourceDocument } from './types.ts';

export interface ProjectContext {
  // The host adapter supplies the worktree root, or the instance directory outside Git.
  root: string;
  baseFile?: string;
  baseExplicit: boolean;
}

export interface LoadedSources {
  // Unique snapshots; orderedProfileIds separately records every replayed occurrence.
  documents: SourceDocument[];
  orderedProfileIds: string[];
  project?: SourceDocument;
  local?: SourceDocument;
  base?: SourceDocument;
}

function freezeValue(value: unknown, depth = 0): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (depth > 32) {
    throw new SettingsError('Composition configuration exceeds 32 levels of JSON nesting.');
  }
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new SettingsError('Composition configuration contains an unsafe object key.');
    }
    freezeValue(child, depth + 1);
  }
  Object.freeze(value);
}

function sourcePath(value: unknown, directory: string): string {
  if (typeof value !== 'string' || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    throw new SettingsError('Composition sources must name local file paths.');
  }
  return configurationPath(value, directory);
}

function activePaths(source: SourceDocument | undefined): string[] | undefined {
  if (source === undefined || !Object.hasOwn(source.value, 'activeProfiles')) {
    return undefined;
  }
  const active = source.value.activeProfiles;
  if (!Array.isArray(active) || active.length > 64) {
    throw new SettingsError('activeProfiles must be an ordered list of at most 64 local file paths.');
  }
  return active.map((path: unknown) => sourcePath(path, dirname(source.path)));
}

function profileParent(source: SourceDocument): string | undefined {
  const value = source.value;
  if (
    Object.keys(value).some((key) => !['extends', 'composition'].includes(key)) ||
    !record(value.composition) ||
    Object.hasOwn(value.composition, 'activeProfiles') ||
    Object.hasOwn(value.composition, 'extends')
  ) {
    throw new SettingsError(
      'Profiles support only a single extends path and a composition object without activation metadata.',
    );
  }
  return Object.hasOwn(value, 'extends') ? sourcePath(value.extends, dirname(source.path)) : undefined;
}

export async function loadCompositionSources(context: ProjectContext): Promise<LoadedSources> {
  const documents = new Map<string, SourceDocument>();
  let totalBytes = 0;
  async function load(path: string, optional = false): Promise<SourceDocument | undefined> {
    // Only a missing directory entry is optional. Malformed/unreadable files and dangling
    // symlinks still fail, rather than silently discarding an intended configuration.
    try {
      await lstat(path);
    } catch (error) {
      if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw new SettingsError(`Could not read composition source: ${path}`);
    }
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch {
      throw new SettingsError(`Could not resolve composition source: ${path}`);
    }
    const cached = documents.get(canonical);
    if (cached !== undefined) {
      return cached;
    }
    // Read aliases through their canonical regular-file target, retaining the existing
    // no-follow reader. Aliases are never advertised as editable destinations.
    const file = await configurationFile(canonical);
    totalBytes += Buffer.byteLength(file.text, 'utf8');
    if (totalBytes > 8 * 1024 * 1024) {
      throw new SettingsError('Composition sources exceed the 8 MiB total text limit.');
    }
    const value = parseConfiguration(file.text);
    freezeValue(value);
    const source: SourceDocument = Object.freeze({
      id: canonical,
      path,
      text: file.text,
      fingerprint: createHash('sha256').update(file.text).digest('hex'),
      writable: canonical === path && (file.mode & 0o222) !== 0,
      value,
    });
    documents.set(canonical, source);
    return source;
  }

  const root = resolve(context.root);
  const basePath = sourcePath(context.baseFile ?? 'config-composer.jsonc', configurationDirectory());
  const base = await load(basePath, !context.baseExplicit);
  const project = await load(join(root, '.opencode/config-composer.jsonc'), true);
  const local = await load(join(root, '.opencode/config-composer.local.jsonc'), true);
  if (base === undefined && project === undefined && local === undefined) {
    throw new SettingsError('No Config Composer configuration source was found.');
  }
  // Validate both lists, but traverse only the effective selection. The base never activates profiles.
  const projectPaths = activePaths(project);
  const localPaths = activePaths(local);
  const active = localPaths ?? projectPaths ?? [];
  const orderedProfileIds: string[] = [];
  const activeIds = new Set<string>();
  async function visit(source: SourceDocument, ancestors: Set<string>): Promise<void> {
    if (ancestors.has(source.id)) {
      throw new SettingsError(`Profile ancestry cycle at ${source.path}`);
    }
    if (ancestors.size >= 32) {
      throw new SettingsError('Profile chains may contain at most 32 levels.');
    }
    const parent = profileParent(source);
    if (parent !== undefined) {
      const parentSource = await load(parent);
      if (parentSource !== undefined) {
        await visit(parentSource, new Set([...ancestors, source.id]));
      }
    }
    orderedProfileIds.push(source.id);
  }
  for (const path of active) {
    const source = await load(path);
    if (source === undefined) {
      continue;
    }
    if (activeIds.has(source.id)) {
      throw new SettingsError(`Duplicate active profile identity: ${path}`);
    }
    activeIds.add(source.id);
    await visit(source, new Set());
  }
  return { documents: [...documents.values()], orderedProfileIds, base, project, local };
}
