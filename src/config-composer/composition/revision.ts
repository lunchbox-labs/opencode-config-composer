import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { type NativeFrontmatterContext, nativeAgentSourceRoots, readNativeAgentFrontmatter } from '../frontmatter.ts';
import type { NativeAuthority, ResolvedCandidate } from './document-types.ts';
import type { LoadedSource } from './sources.ts';
import type { SelectionSnapshot } from './selection-state.ts';
export interface CompositionRevision {
  sources: string;
  effective: string;
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface NativeObservation {
  context: NativeFrontmatterContext;
  authority: NativeAuthority;
  metadata: string;
  json: string;
  globalJson: string;
  commands: string;
}
export function discoveryContext(directory: string, worktree: string): NativeFrontmatterContext {
  return {
    directory,
    worktree,
    home: homedir(),
    environment: Object.fromEntries(
      [
        'XDG_CONFIG_HOME',
        'OPENCODE_DISABLE_PROJECT_CONFIG',
        'OPENCODE_TEST_HOME',
        'OPENCODE_CONFIG_DIR',
        'OPENCODE_CONFIG',
      ].flatMap((key) => {
        const value = process.env[key];
        return value === undefined
          ? []
          : [[key, key !== 'OPENCODE_DISABLE_PROJECT_CONFIG' && value !== '' ? resolve(value) : value]];
      }),
    ),
  };
}
async function observation(path: string, bytes = false): Promise<unknown> {
  try {
    const info = await lstat(path);
    const target = await realpath(path);
    return [
      resolve(path),
      target,
      info.dev,
      info.ino,
      info.isSymbolicLink(),
      ...(bytes
        ? [
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ]
        : []),
    ];
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [resolve(path), null];
    }
    throw error;
  }
}
export function nativeGlobalJsonPaths(context: NativeFrontmatterContext): string[] {
  const root = nativeAgentSourceRoots(context)[0];
  return ['config', 'config.json', 'opencode.json', 'opencode.jsonc'].map((name) => join(root, name));
}
export function nativeJsonPaths(context: NativeFrontmatterContext): string[] {
  const roots = nativeAgentSourceRoots(context);
  const jsonPaths = new Set(
    roots.flatMap((root) => ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => join(root, name))),
  );
  for (let directory = context.directory; ; directory = dirname(directory)) {
    jsonPaths.add(join(directory, 'opencode.json'));
    jsonPaths.add(join(directory, 'opencode.jsonc'));
    if (directory === context.worktree || dirname(directory) === directory) {
      break;
    }
  }
  const explicit = context.environment?.OPENCODE_CONFIG;
  if (explicit !== undefined && explicit !== '') {
    jsonPaths.add(explicit);
  }
  return [...new Set([...jsonPaths, ...nativeGlobalJsonPaths(context)])];
}
/** Native command bodies are opaque; fingerprint bytes and identities without interpreting their contents. */
export async function nativeCommandPaths(context: NativeFrontmatterContext): Promise<string[]> {
  const paths: string[] = [];
  const scan = async (directory: string, parents = new Set<string>()): Promise<void> => {
    const identity = await realpath(directory).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (identity === undefined || parents.has(identity)) {
      return;
    }
    const ancestors = new Set([...parents, identity]);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = entry.isSymbolicLink() ? await stat(path) : entry;
      if (info.isDirectory()) {
        await scan(path, ancestors);
      } else if (info.isFile() && entry.name.endsWith('.md')) {
        paths.push(path);
      }
    }
  };
  for (const root of nativeAgentSourceRoots(context)) {
    for (const name of ['command', 'commands']) {
      await scan(join(root, name));
    }
  }
  return paths.sort();
}
export async function observeNative(context: NativeFrontmatterContext): Promise<NativeObservation> {
  const authority = Object.fromEntries(await readNativeAgentFrontmatter(context));
  const roots = nativeAgentSourceRoots(context);
  const fingerprints = (paths: string[]) => Promise.all(paths.map((path) => observation(path, true)));
  // Collect independent fingerprints concurrently while preserving each category's path order.
  const [discovery, sources, json, globalJson, commands] = await Promise.all([
    Promise.all(
      roots
        .flatMap((root) => [root, ...['agent', 'agents', 'mode', 'modes'].map((name) => join(root, name))])
        .map((path) => observation(path)),
    ),
    // Independent agents may be enumerated differently by the native host and editor.
    // Keep each agent's source chain in native precedence order.
    Promise.all(
      Object.keys(authority)
        .sort()
        .flatMap((name) => authority[name].sources)
        .map(async (source) => [source, await observation(source.path)]),
    ),
    fingerprints(nativeJsonPaths(context)),
    fingerprints(nativeGlobalJsonPaths(context)),
    nativeCommandPaths(context).then(fingerprints),
  ]);
  return {
    context,
    authority,
    metadata: digest([discovery, sources]),
    json: digest(json),
    globalJson: digest(globalJson),
    commands: digest(commands),
  };
}
export function compositionRevision(
  source: LoadedSource,
  state: SelectionSnapshot,
  candidate: ResolvedCandidate,
): CompositionRevision {
  return {
    sources: digest([source.path, source.canonicalPath, source.fingerprint, state.text ?? null]),
    effective: digest({
      ...candidate,
      agent: Object.fromEntries(
        Object.entries(candidate.agent).map(([name, entry]) => [
          name,
          Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'prompt')),
        ]),
      ),
      command: Object.fromEntries(
        Object.entries(candidate.command).map(([name, entry]) => [
          name,
          Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'template')),
        ]),
      ),
    }),
  };
}
