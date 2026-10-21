import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { type Node as JsonNode, type ParseError, parse, parseTree, printParseErrorCode } from 'jsonc-parser';
import { type GroupOptions, SettingsError, readSettings, record } from './settings.ts';
import type { SourceDocument } from './composition/types.ts';

export interface ConfigurationFile {
  path: string;
  text: string;
  mode: number;
}
export interface LoadedConfiguration {
  settings: GroupOptions;
  file: ConfigurationFile;
  source: SourceDocument;
}

export const MAX_CONFIGURATION_BYTES = 1024 * 1024;

export function configurationDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.OPENCODE_CONFIG_DIR;
  if (configured !== undefined && configured !== '') {
    return resolve(configured);
  }
  const xdg = environment.XDG_CONFIG_HOME;
  return xdg !== undefined && isAbsolute(xdg) ? join(xdg, 'opencode') : join(homedir(), '.config', 'opencode');
}

export function configurationPath(value: string, directory: string): string {
  if (value.trim() === '' || value.includes('\0')) {
    throw new SettingsError('Select a valid Config Composer configuration path.');
  }
  const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(directory, expanded);
}

// Parser offsets and columns count UTF-16 code units, including raw escapes and tabs.
function location(text: string, offset: number): string {
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
  return `line ${lines.length}, column ${lines[lines.length - 1].length + 1}`;
}

function uniqueKeys(node: JsonNode | undefined, text: string, source: string): void {
  if (node === undefined) {
    return;
  }
  if (node.type === 'object') {
    const keys = new Map<unknown, number>();
    for (const child of node.children ?? []) {
      const key = child.children?.[0];
      if (key === undefined) {
        continue;
      }
      const first = keys.get(key.value);
      if (first !== undefined) {
        throw new SettingsError(
          `${source}The Config Composer configuration has duplicate JSON keys: ${JSON.stringify(key.value)} at ${location(text, first)} and ${location(text, key.offset)}.`,
        );
      }
      keys.set(key.value, key.offset);
    }
  }
  node.children?.forEach((child) => uniqueKeys(child, text, source));
}

export function parseConfiguration(text: string, sourceId?: string): Record<string, unknown> {
  const source = sourceId === undefined ? '' : `${sourceId}: `;
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length !== 0 || !record(value)) {
    const first = errors.at(0);
    const detail =
      first === undefined ? '' : ` ${printParseErrorCode(first.error)} at ${location(text, first.offset)}.`;
    throw new SettingsError(`${source}Fix the invalid Config Composer JSONC configuration.${detail}`);
  }
  uniqueKeys(parseTree(text), text, source);
  return value;
}

export async function configurationFile(path: string): Promise<ConfigurationFile> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size > MAX_CONFIGURATION_BYTES) {
      throw new SettingsError('The Config Composer configuration must be a regular file no larger than 1 MiB.');
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await file.stat();
      if (
        !current.isFile() ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        current.size > MAX_CONFIGURATION_BYTES
      ) {
        throw new SettingsError('The Config Composer configuration changed while loading. Try again.');
      }
      const bytes = await file.readFile();
      if (bytes.length > MAX_CONFIGURATION_BYTES) {
        throw new SettingsError('The Config Composer configuration must be no larger than 1 MiB.');
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { path, text, mode: current.mode };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof SettingsError) {
      throw error;
    }
    throw new SettingsError(
      'Could not read the Config Composer configuration. Check that configFile names a readable UTF-8 regular file.',
    );
  }
}

export async function loadConfiguration(
  options: unknown,
  directory = configurationDirectory(),
): Promise<LoadedConfiguration> {
  if (options === undefined) {
    options = {};
  }
  if (
    !record(options) ||
    Object.keys(options).some((key) => !['configFile', 'reloadToken'].includes(key)) ||
    (Object.hasOwn(options, 'configFile') && typeof options.configFile !== 'string') ||
    (options.reloadToken !== undefined && typeof options.reloadToken !== 'string')
  ) {
    throw new SettingsError(
      'Config Composer plugin options support only configFile and an optional reloadToken. Put settings in config-composer.jsonc or the selected file.',
    );
  }
  const file = await configurationFile(
    configurationPath(typeof options.configFile === 'string' ? options.configFile : 'config-composer.jsonc', directory),
  );
  const value = parseConfiguration(file.text, file.path);
  const settings = readSettings(value);
  return {
    settings,
    file,
    source: {
      id: file.path,
      path: file.path,
      text: file.text,
      fingerprint: createHash('sha256').update(file.text).digest('hex'),
      // Advisory only: storage must still check identity, permissions and mode on save.
      writable: (file.mode & 0o222) !== 0,
      value,
    },
  };
}
