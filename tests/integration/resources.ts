import { readFile, readdir } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { killProcessTree } from './process.ts';

export function registerProcess(
  pid: number,
  root: string,
  registry = process.env.INTEGRATION_PROCESS_REGISTRY,
): () => void {
  if (registry === undefined) {
    return () => {};
  }
  const record = join(registry, `${pid}.json`);
  // Publish synchronously before yielding to test code or waiting for startup.
  writeFileSync(record, JSON.stringify({ pid, root }));
  return () => rmSync(record, { force: true });
}

export async function cleanupProcesses(registry: string, root: string): Promise<void> {
  const failures: unknown[] = [];
  for (const name of await readdir(registry)) {
    const record = join(registry, name);
    const contents = await readFile(record, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (contents === undefined) {
      continue;
    }
    const entry = JSON.parse(contents) as { pid: number; root: string };
    const path = relative(root, entry.root);
    // Nested regression runners share the registry; each cleans only its own roots.
    if (isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\')) {
      continue;
    }
    try {
      await killProcessTree(entry.pid);
      rmSync(record, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not stop all integration processes');
  }
}
