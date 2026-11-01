import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { MAX_CONFIGURATION_BYTES, configurationFile, configurationPath, parseConfiguration } from '../configuration.ts';
import { configurationDirectory } from '../configuration-directory.ts';
import { SettingsError, record } from '../settings.ts';
import { canonical } from './selection-state.ts';
import { readCompositionDocument } from './document.ts';
import type { CompositionDocument } from './document-types.ts';
export interface LoadedSource {
  path: string;
  canonicalPath: string;
  fingerprint: string;
  document: CompositionDocument;
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
export async function loadSource(
  options: { configFile?: string } = {},
  directory = configurationDirectory(),
): Promise<LoadedSource> {
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
    return {
      path,
      canonicalPath,
      fingerprint: createHash('sha256').update('null').digest('hex'),
      document: readCompositionDocument({}),
    };
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
    throw new SettingsError('Composition source changed while loading. Reopen Config Composer.');
  }
  return {
    path,
    canonicalPath,
    fingerprint: createHash('sha256').update(JSON.stringify(file.text)).digest('hex'),
    document: parseSourceDocument(file.text, path),
  };
}
