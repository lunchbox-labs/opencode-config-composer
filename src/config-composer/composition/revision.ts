import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { type NativeFrontmatterContext, nativeAgentSourceRoots, readNativeAgentFrontmatter } from '../frontmatter.ts';
import type { NativeAuthority, ResolvedCandidate } from './document-types.ts';
import type { Source } from './sources.ts';
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
export async function observeNative(context: NativeFrontmatterContext): Promise<NativeObservation> {
  const authority = Object.fromEntries(await readNativeAgentFrontmatter(context));
  const roots = nativeAgentSourceRoots(context);
  const discovery = await Promise.all(
    roots
      .flatMap((root) => [root, ...['agent', 'agents', 'mode', 'modes'].map((name) => join(root, name))])
      .map((path) => observation(path)),
  );
  const sources = await Promise.all(
    Object.values(authority)
      .flatMap((item) => item.sources)
      .map(async (source) => [source, await observation(source.path)]),
  );
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
  return {
    context,
    authority,
    metadata: digest([discovery, sources]),
    json: digest(await Promise.all([...jsonPaths].map((path) => observation(path, true)))),
  };
}
export function compositionRevision(
  source: Source,
  state: SelectionSnapshot,
  candidate: ResolvedCandidate,
): CompositionRevision {
  return {
    sources: digest([source.path, source.canonicalPath, source.text, state.text ?? null]),
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
