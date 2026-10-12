import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { SettingsError, record } from '../settings.ts';
import { readCompositionDocument } from './document.ts';

/** OpenCode 1.18.34 uses xdg-basedir on every platform, including Windows.
 * /path requires completed plugin bootstrap, so it cannot be called during initialization.
 */
export function selectionStateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const state = environment.XDG_STATE_HOME;
  return join(state !== undefined && isAbsolute(state) ? state : join(homedir(), '.local', 'state'), 'opencode');
}

export interface SelectionEnvironment {
  stateDirectory: string;
  lifetime: string;
}
export interface SelectionSnapshot {
  path: string;
  text?: string;
  profiles?: string[];
  revision: number;
}

/** Survives instance disposal and duplicate module loads, but never a server process restart. */
export function selectionLifetime(): string {
  const key = Symbol.for('@lunchbox-labs/config-composer/selection-lifetime');
  const existing: unknown = Reflect.get(globalThis, key);
  if (typeof existing === 'string') {
    return existing;
  }
  const value = randomUUID();
  Reflect.set(globalThis, key, value);
  return value;
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
    const parent = dirname(path);
    if (parent === path) {
      throw error;
    }
    return join(await canonical(parent), basename(path));
  }
}

async function proofPath(environment: SelectionEnvironment): Promise<string> {
  if (!isAbsolute(environment.stateDirectory) || !/^[a-z0-9-]+$/i.test(environment.lifetime)) {
    throw new SettingsError('Invalid OpenCode selection state location.');
  }
  const root = await canonical(resolve(environment.stateDirectory));
  const path = join(root, 'config-composer', 'v1', 'processes', environment.lifetime, 'proof');
  if ((await canonical(dirname(path))) !== dirname(path)) {
    throw new Error('Redirected state directory');
  }
  return path;
}

export async function verifySelectionProof(environment: SelectionEnvironment): Promise<void> {
  try {
    const path = await proofPath(environment);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 1024 ||
      (await readFile(path, 'utf8')) !== environment.lifetime
    ) {
      throw new Error('Missing server proof');
    }
  } catch {
    throw new SettingsError(
      'The OpenCode server state filesystem is not shared or changed. Reconnect using the same state filesystem before editing.',
    );
  }
}

/** Server-created capability proves a shared state mount independently of project/config mounts. */
export async function publishSelectionProof(environment: SelectionEnvironment): Promise<void> {
  const path = await proofPath(environment);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const exists = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (exists === undefined) {
    const temporary = join(dirname(path), `.proof-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(environment.lifetime, 'utf8');
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  await verifySelectionProof(environment);
}

async function observe(path: string): Promise<SelectionSnapshot> {
  let text: string;
  try {
    if ((await canonical(dirname(path))) !== dirname(path)) {
      throw new Error('State directory changed identity');
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32_768) {
      throw new Error('Invalid state file');
    }
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { path, revision: 0 };
    }
    throw new SettingsError(`Cannot read selection state ${path}. Restore or remove this file before continuing.`);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      !record(value) ||
      value.version !== 1 ||
      typeof value.revision !== 'number' ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !record(value.selection) ||
      Object.keys(value).some((key) => !['version', 'revision', 'selection'].includes(key))
    ) {
      throw new Error('Invalid state');
    }
    const selection = value.selection;
    if (selection.mode !== 'defaults' && selection.mode !== 'override') {
      throw new Error('Invalid selection');
    }
    if (Object.keys(selection).some((key) => !['mode', 'profiles'].includes(key))) {
      throw new Error('Invalid selection');
    }
    if (selection.mode === 'defaults' && selection.profiles !== undefined) {
      throw new Error('Invalid defaults');
    }
    if (selection.mode === 'override' && selection.profiles === undefined) {
      throw new Error('Missing profiles');
    }
    const profiles =
      selection.mode === 'override'
        ? readCompositionDocument({ activeProfiles: selection.profiles }).activeProfiles
        : undefined;
    return { path, text, revision: value.revision, profiles };
  } catch {
    throw new SettingsError(
      `Invalid or unsupported selection state ${path}. Restore or remove this file before continuing.`,
    );
  }
}

export async function readSelection(
  environment: SelectionEnvironment,
  identity: { root: string; baseFile: string },
  retainOnRestart: boolean,
): Promise<SelectionSnapshot> {
  if (!isAbsolute(environment.stateDirectory) || !/^[a-z0-9-]+$/i.test(environment.lifetime)) {
    throw new SettingsError('Invalid OpenCode selection state location.');
  }
  const root = await canonical(resolve(identity.root));
  const base = await canonical(resolve(identity.baseFile));
  const key = createHash('sha256')
    .update(JSON.stringify([root, base]))
    .digest('hex');
  const directory = await canonical(resolve(environment.stateDirectory));
  const namespace = retainOnRestart ? 'projects' : join('processes', environment.lifetime);
  return observe(join(directory, 'config-composer', 'v1', namespace, `${key}.json`));
}

export async function verifySelection(snapshot: SelectionSnapshot): Promise<void> {
  if ((await observe(snapshot.path)).text !== snapshot.text) {
    throw new SettingsError('Profile selection changed. Reopen the editor.');
  }
}

/** Serialize state mutations and apply against the same selection revision. */
export async function withSelectionLock<T>(snapshot: SelectionSnapshot, operation: () => Promise<T>): Promise<T> {
  const directory = dirname(snapshot.path);
  if ((await canonical(directory)) !== directory) {
    throw new SettingsError('Selection state directory changed identity. Reopen the editor.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory) {
    throw new SettingsError('Selection state directory changed identity. Reopen the editor.');
  }
  const lockPath = `${snapshot.path}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new SettingsError(`Another selection edit is active, or a stale selection lock needs attention: ${lockPath}`);
  });
  try {
    await verifySelection(snapshot);
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Prepare the state write before other edits; publish it as the final operation of their rollback boundary. */
export async function withSelectionUpdate(
  snapshot: SelectionSnapshot,
  profiles: string[] | undefined,
  operation: (commit: () => Promise<void>) => Promise<void>,
): Promise<void> {
  if (profiles !== undefined) {
    readCompositionDocument({ activeProfiles: profiles });
  }
  await withSelectionLock(snapshot, async () => {
    const temporary = join(dirname(snapshot.path), `.selection-${randomUUID()}.tmp`);
    const text =
      JSON.stringify({
        version: 1,
        revision: snapshot.revision + 1,
        selection: profiles === undefined ? { mode: 'defaults' } : { mode: 'override', profiles },
      }) + '\n';
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(text, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await operation(async () => {
        await verifySelection(snapshot);
        await rename(temporary, snapshot.path);
      });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  });
}

export async function saveSelection(
  snapshot: SelectionSnapshot,
  profiles: string[] | undefined,
  validate?: () => Promise<void>,
): Promise<void> {
  await withSelectionUpdate(snapshot, profiles, async (commit) => {
    await validate?.();
    await commit();
  });
}
