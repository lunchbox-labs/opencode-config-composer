import { lstat, realpath } from 'node:fs/promises';
import { configurationDirectory, configurationFile, configurationPath, parseConfiguration } from '../configuration.ts';
import { SettingsError, record } from '../settings.ts';
import { canonical } from './selection-state.ts';
import { readCompositionDocument } from './document.ts';
import type { CompositionDocument } from './document-types.ts';
export interface Source {
  path: string;
  canonicalPath: string;
  text?: string;
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
    identity: `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}:${info.mode}:${link.dev}:${link.ino}:${link.mtimeMs}`,
    document: readCompositionDocument(parseConfiguration(file.text, path)),
  };
}
