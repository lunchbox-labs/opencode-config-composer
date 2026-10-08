import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageName } from './package-name.ts';

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
    const path = resolve(spec.startsWith('file:') ? fileURLToPath(spec) : resolve(root, spec));
    return [
      fileURLToPath(new URL('../server.ts', import.meta.url)),
      fileURLToPath(new URL('../server.js', import.meta.url)),
      resolve(fileURLToPath(new URL('../../', import.meta.url))),
    ].includes(path);
  } catch {
    return false;
  }
}
