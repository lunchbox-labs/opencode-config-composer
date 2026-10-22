import { changedInput } from '../save-diagnostics.ts';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { SettingsError, record } from '../settings.ts';
import type { Selection } from './document-types.ts';

/** OpenCode 1.19.0 uses xdg-basedir on every platform, including Windows.
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
  choice?: Selection;
  identity?: string;
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

export async function canonical(path: string): Promise<string> {
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
  const path = join(root, 'config-composer', 'v2', 'processes', environment.lifetime, 'proof');
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
  let captured: string;
  try {
    if ((await canonical(dirname(path))) !== dirname(path)) {
      throw new Error('State directory changed identity');
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32_768) {
      throw new Error('Invalid state file');
    }
    captured = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}:${info.mode}`;
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
      value.version !== 2 ||
      typeof value.revision !== 'number' ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !record(value.selection) ||
      Object.keys(value).some((key) => !['version', 'revision', 'selection'].includes(key))
    ) {
      throw new Error('Invalid state');
    }
    const selection = value.selection;
    if (
      Object.keys(selection).some((key) => key !== 'choice') ||
      (Object.hasOwn(selection, 'choice') && selection.choice !== null && typeof selection.choice !== 'string')
    ) {
      throw new Error('Invalid selection');
    }
    const info = await lstat(path);
    if (
      captured !== `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}:${info.mode}` ||
      !info.isFile() ||
      info.isSymbolicLink()
    ) {
      throw new Error('Selection changed while reading');
    }
    return {
      path,
      text,
      revision: value.revision,
      choice: typeof selection.choice === 'string' || selection.choice === null ? selection.choice : undefined,
      identity: captured,
    };
  } catch {
    throw new SettingsError(
      `Invalid or unsupported selection state ${path}. Restore or remove this file before continuing.`,
    );
  }
}

export interface SelectionLocator {
  root: string;
  baseFile: string;
  path: string;
}
function selectionPath(directory: string, identity: { root: string; baseFile: string }): string {
  const key = createHash('sha256')
    .update(JSON.stringify([identity.root, identity.baseFile]))
    .digest('hex');
  return join(directory, 'config-composer', 'v2', 'worktrees', `${key}.json`);
}
export async function selectionLocator(
  environment: SelectionEnvironment,
  identity: { root: string; baseFile: string },
): Promise<SelectionLocator> {
  const root = await canonical(resolve(identity.root));
  const baseFile = identity.baseFile;
  const directory = await canonical(resolve(environment.stateDirectory));
  return { root, baseFile, path: selectionPath(directory, { root, baseFile }) };
}
/** The source/worktree binding is captured at startup; only the state filesystem stays live. */
export async function readSelectionAt(
  environment: SelectionEnvironment,
  locator: SelectionLocator,
): Promise<SelectionSnapshot> {
  if (
    !isAbsolute(environment.stateDirectory) ||
    !/^[a-z0-9-]+$/i.test(environment.lifetime) ||
    !isAbsolute(locator.root) ||
    !isAbsolute(locator.baseFile)
  ) {
    throw new SettingsError('Invalid OpenCode selection state location.');
  }
  const directory = await canonical(resolve(environment.stateDirectory));
  if (selectionPath(directory, locator) !== locator.path) {
    throw new SettingsError('Selection state directory changed identity. Reopen Config Composer.');
  }
  return observe(locator.path);
}
export async function verifySelection(snapshot: SelectionSnapshot): Promise<void> {
  const current = await observe(snapshot.path);
  if (current.text !== snapshot.text || current.identity !== snapshot.identity) {
    throw changedInput('Profile selection changed. Reopen Config Composer.', snapshot.path, 'selection');
  }
}

/** Serialize state mutations and apply against the same selection revision. */
export async function withSelectionLock<T>(snapshot: SelectionSnapshot, operation: () => Promise<T>): Promise<T> {
  const directory = dirname(snapshot.path);
  if ((await canonical(directory)) !== directory) {
    throw changedInput('Selection state directory changed identity. Reopen Config Composer.', directory, 'identity');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory) {
    throw changedInput('Selection state directory changed identity. Reopen Config Composer.', directory, 'identity');
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

async function writeSelectionLocked(
  snapshot: SelectionSnapshot,
  choice: Selection,
  validate: () => Promise<void>,
): Promise<SelectionSnapshot> {
  await validate();
  const temporary = join(dirname(snapshot.path), `.selection-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          version: 2,
          revision: snapshot.revision + 1,
          selection: choice === undefined ? {} : { choice },
        }) + '\n',
      );
      await file.sync();
    } finally {
      await file.close();
    }
    const committed = await observe(temporary);
    await validate();
    await verifySelection(snapshot);
    await rename(temporary, snapshot.path);
    return { ...committed, path: snapshot.path };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Persist a selection under its scoped lock. */
export async function saveSelection(
  snapshot: SelectionSnapshot,
  choice: Selection,
  validate: () => Promise<void>,
): Promise<SelectionSnapshot> {
  return withSelectionLock(snapshot, () => writeSelectionLocked(snapshot, choice, validate));
}
