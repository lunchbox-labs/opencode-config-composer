import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageName } from './package-name.ts';

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function serverEntry(spec: unknown, root: string): boolean {
  if (typeof spec !== 'string') {
    return false;
  }
  if (spec === packageName) {
    return true;
  }
  if (spec.startsWith(`${packageName}@`)) {
    const version = spec.slice(packageName.length + 1);
    return version !== '' && /^[a-z0-9.*+~^<>=| -]+$/i.test(version);
  }
  try {
    const path = canonicalPath(spec.startsWith('file:') ? fileURLToPath(spec) : resolve(root, spec));
    return [
      fileURLToPath(new URL('../server.ts', import.meta.url)),
      fileURLToPath(new URL('../server.js', import.meta.url)),
      resolve(fileURLToPath(new URL('../../', import.meta.url))),
    ].some((candidate) => canonicalPath(candidate) === path);
  } catch {
    return false;
  }
}
