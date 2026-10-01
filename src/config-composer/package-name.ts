import { readFileSync } from 'node:fs';
import { record } from './settings.ts';

// This location is the same relative to src/ and dist/. Keep identity in one manifest.
const manifest: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
if (!record(manifest) || typeof manifest.name !== 'string' || manifest.name === '') {
  throw new Error('The Config Composer package manifest must contain a name.');
}
export const packageName = manifest.name;
