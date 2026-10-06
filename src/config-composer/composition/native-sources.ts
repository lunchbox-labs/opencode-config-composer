import { lstat, readdir, realpath } from 'node:fs/promises';
import path, { join, relative } from 'node:path';
import { configurationFile } from '../configuration.ts';
import { SettingsError } from '../settings.ts';
import type { SourceFile } from '../storage.ts';

export interface NativeAgentLayer {
  file: SourceFile;
  kind: 'config' | 'markdown';
  name?: string;
  primary?: boolean;
  batch?: string;
  project: boolean;
}
export interface NativeProjectSources {
  configurations: NativeAgentLayer[];
  directories: NativeAgentLayer[];
}

/** The native non-Git "/" sentinel means the opened directory's filesystem root. */
export function nativeAncestorPaths(root: string, directory: string, paths = path): string[] {
  const project = root === '/' ? paths.parse(directory).root : root;
  const inside = paths.relative(project, directory);
  if (inside === '..' || inside.startsWith(`..${paths.sep}`) || paths.isAbsolute(inside)) {
    throw new SettingsError('The native project directory must be inside its worktree.');
  }
  const ancestors: string[] = [];
  for (let current = directory; ; current = paths.dirname(current)) {
    ancestors.push(current);
    if (paths.relative(project, current) === '') {
      return ancestors;
    }
    if (ancestors.length >= 64 || paths.dirname(current) === current) {
      throw new SettingsError('Native project discovery exceeds 64 directories or its worktree boundary.');
    }
  }
}

/** Mirror native project paths only; Composer definitions still require explicit imports. */
export async function loadNativeProjectSources(root: string, directory = root): Promise<NativeProjectSources> {
  const configurations: NativeAgentLayer[] = [];
  const directories: NativeAgentLayer[] = [];
  if (['true', '1'].includes(process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? '')) {
    return { configurations, directories };
  }
  const start = await realpath(directory);
  const ancestors = nativeAncestorPaths(root === '/' ? root : await realpath(root), start);
  let bytes = 0;
  let count = 0;
  const exists = async (path: string) => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  };
  const capture = async (path: string): Promise<SourceFile> => {
    const canonicalPath = await realpath(path);
    const file = await configurationFile(canonicalPath);
    bytes += Buffer.byteLength(file.text, 'utf8');
    if (++count > 1024 || bytes > 8 * 1024 * 1024) {
      throw new SettingsError('Native project sources exceed 1024 files or 8 MiB.');
    }
    return { ...file, path, canonicalPath, writable: false, mode: file.mode & 0o777 };
  };
  async function configs(path: string, target: NativeAgentLayer[]) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const file = join(path, name);
      if (await exists(file)) {
        target.push({ file: await capture(file), kind: 'config', project: true });
      }
    }
  }
  // Native root JSON is overlaid by descendant JSON; .opencode directories use nearest-to-root order.
  for (const path of ancestors.toReversed()) {
    await configs(path, configurations);
  }
  async function scan(path: string, base: string, primary: boolean, batch: string, parents = new Set<string>()) {
    const canonical = await realpath(path);
    if (parents.has(canonical) || parents.size >= 32) {
      throw new SettingsError(`Native agent directory cycle or depth limit at ${path}.`);
    }
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      const info = await lstat(await realpath(file));
      if (info.isDirectory()) {
        if (!primary) {
          await scan(file, base, primary, batch, new Set([...parents, canonical]));
        }
      } else if (entry.name.endsWith('.md')) {
        directories.push({
          file: await capture(file),
          kind: 'markdown',
          name: relative(base, file).replaceAll('\\', '/').slice(0, -3),
          primary,
          batch,
          project: true,
        });
      }
    }
  }
  for (const path of ancestors) {
    const config = join(path, '.opencode');
    if (!(await exists(config))) {
      continue;
    }
    await configs(config, directories);
    for (const name of ['agent', 'agents', 'mode', 'modes']) {
      const folder = join(config, name);
      if (await exists(folder)) {
        const primary = name === 'mode' || name === 'modes';
        await scan(folder, folder, primary, `${config}/${primary ? 'modes' : 'agents'}`);
      }
    }
  }
  return { configurations, directories };
}
