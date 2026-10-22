import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import {
  MAX_CONFIGURATION_BYTES,
  configurationDirectory,
  configurationFile,
  configurationPath,
  parseConfiguration,
} from '../configuration.ts';
import { SettingsError, record } from '../settings.ts';
import { canonical } from './selection-state.ts';
import { readCompositionDocument } from './document.ts';
import type { CompositionDocument } from './document-types.ts';
export interface Source {
  path: string;
  canonicalPath: string;
  text?: string;
  mode?: number;
  identity?: string;
  document: CompositionDocument;
  explicit: boolean;
}
export function pluginOptions(value: unknown): { configFile?: string } {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== 'configFile' && key !== '__configComposerRuntime') ||
    (Object.hasOwn(value, 'configFile') && typeof value.configFile !== 'string')
  ) {
    throw new SettingsError('Config Composer plugin options support only configFile.');
  }
  return typeof value.configFile === 'string' ? { configFile: value.configFile } : {};
}
export function parseSourceDocument(text: string, path?: string): CompositionDocument {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIGURATION_BYTES) {
    throw new SettingsError('The Config Composer configuration must be no larger than 1 MiB.');
  }
  return readCompositionDocument(parseConfiguration(text, path));
}
function sourceIdentity(info: Stats, link: Stats): string {
  return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}:${info.mode}:${link.dev}:${link.ino}:${link.mtimeMs}`;
}
export async function loadSource(
  options: { configFile?: string } = {},
  directory = configurationDirectory(),
): Promise<Source> {
  const path = configurationPath(options.configFile ?? 'config-composer.jsonc', directory);
  const canonicalPath = await canonical(path);
  const explicit = Object.hasOwn(options, 'configFile');
  const info = await lstat(canonicalPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (info === undefined) {
    if (explicit) {
      throw new SettingsError(`Explicit Config Composer source does not exist: ${path}`);
    }
    return { path, canonicalPath, explicit, document: readCompositionDocument({}) };
  }
  const link = await lstat(path);
  const file = await configurationFile(canonicalPath);
  const after = await lstat(canonicalPath);
  const linkAfter = await lstat(path);
  const finalTarget = await realpath(path);
  if (
    info.ino !== after.ino ||
    info.dev !== after.dev ||
    info.mtimeMs !== after.mtimeMs ||
    info.size !== after.size ||
    info.mode !== after.mode ||
    link.ino !== linkAfter.ino ||
    link.dev !== linkAfter.dev ||
    link.mtimeMs !== linkAfter.mtimeMs ||
    link.mode !== linkAfter.mode ||
    canonicalPath !== finalTarget
  ) {
    throw new SettingsError('Composition source changed while loading. Reopen the editor.');
  }
  return {
    path,
    canonicalPath,
    explicit,
    text: file.text,
    mode: file.mode,
    identity: sourceIdentity(info, link),
    document: parseSourceDocument(file.text, path),
  };
}

/** Serializes the one shared source across worktrees, before taking a selection lock. */
export async function withSourceLock<T>(source: Source, operation: () => Promise<T>): Promise<T> {
  const directory = dirname(source.canonicalPath);
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)) !== directory || (await canonical(source.path)) !== source.canonicalPath) {
    throw new SettingsError('Composition source identity changed. Reopen the editor.');
  }
  const path = `${source.canonicalPath}.composer.lock`;
  const lock = await open(path, 'wx', 0o600).catch(() => {
    throw new SettingsError('Another Composer source edit is active. Reopen the editor after it finishes.');
  });
  try {
    return await operation();
  } finally {
    await lock.close();
    await unlink(path);
  }
}
/** Caller holds the canonical source lock. Snapshot identity comes from our temporary inode. */
export async function replaceSource(source: Source, text: string, validate: () => Promise<void>): Promise<Source> {
  const document = parseSourceDocument(text, source.path);
  const temporary = join(dirname(source.canonicalPath), `.composer-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', source.mode === undefined ? 0o600 : source.mode & 0o7777);
    try {
      await file.writeFile(text, 'utf8');
      if (source.mode !== undefined) {
        await file.chmod(source.mode & 0o7777);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    const info = await lstat(temporary);
    const link =
      source.path === source.canonicalPath
        ? info
        : await lstat(source.path).catch((error: unknown) => {
            if (source.text === undefined && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
              return info;
            }
            throw error;
          });
    const persisted: Source = {
      ...source,
      text,
      document,
      mode: info.mode,
      identity: sourceIdentity(info, link.isSymbolicLink() ? link : info),
    };
    await validate();
    await rename(temporary, source.canonicalPath);
    return persisted;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
