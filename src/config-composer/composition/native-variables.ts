import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configurationFile, configurationPath } from '../configuration.ts';
import { SettingsError } from '../settings.ts';
import type { SourceFile } from '../storage.ts';

export interface NativeVariables {
  environment: Map<string, string | undefined>;
  files: Map<string, SourceFile>;
  documents: Map<string, string>;
}

/** Pinned native JSONC substitution order; original source text remains untouched. */
export async function substituteNativeConfig(
  file: SourceFile,
  variables: NativeVariables,
  capture = false,
  overlays: ReadonlyMap<string, string> = new Map(),
): Promise<string> {
  const text = file.text.replace(/\{env:([^}]+)\}/g, (_token, key: string) => {
    if (capture && !variables.environment.has(key)) {
      variables.environment.set(key, process.env[key]);
    }
    if (!variables.environment.has(key)) {
      throw new SettingsError('Native substitution inputs changed. Reopen the editor.');
    }
    return variables.environment.get(key) ?? '';
  });
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const index = match.index;
    const token = match[0];
    result += text.slice(cursor, index);
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    if (text.slice(lineStart, index).trimStart().startsWith('//')) {
      result += token;
    } else {
      const path = configurationPath(token.slice(6, -1), dirname(file.path));
      let dependency = variables.files.get(path);
      if (dependency === undefined && capture) {
        if (variables.files.size >= 64) {
          throw new SettingsError('Native substitutions exceed 64 referenced files.');
        }
        const canonicalPath = await realpath(path);
        const source = await configurationFile(canonicalPath);
        dependency = { ...source, path, canonicalPath, mode: source.mode & 0o777, writable: false };
        variables.files.set(path, dependency);
        if (
          [...variables.files.values()].reduce((bytes, file) => bytes + Buffer.byteLength(file.text), 0) >
          8 * 1024 * 1024
        ) {
          throw new SettingsError('Native substitution files exceed 8 MiB.');
        }
      }
      if (dependency === undefined) {
        throw new SettingsError('Native substitution inputs changed. Reopen the editor.');
      }
      const content = overlays.get(path) ?? overlays.get(dependency.canonicalPath ?? path) ?? dependency.text;
      result += JSON.stringify(content.trim()).slice(1, -1);
    }
    cursor = index + token.length;
  }
  const substituted = result + text.slice(cursor);
  if (capture) {
    variables.documents.set(file.path, substituted);
  }
  return substituted;
}

export function observedNativeVariables(variables: NativeVariables): void {
  for (const [name, value] of variables.environment) {
    if (process.env[name] !== value) {
      throw new SettingsError('Native substitution environment changed. Reopen the editor.');
    }
  }
}
