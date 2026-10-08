import assert from 'node:assert/strict';
import { join } from 'node:path';

export interface NativePermissionRule {
  permission: string;
  pattern: string;
  action: string;
}

export function normalizeBundledPermissions(rules: NativePermissionRule[], directory: string): NativePermissionRule[] {
  const bundledPatterns = ['config-composer-explain', 'config-composer-create', 'config-composer-migrate'].map(
    (name) => `${join(directory, 'skills', name)}/*`,
  );
  const positions = rules.flatMap((rule, index) => (bundledPatterns.includes(rule.pattern) ? [index] : []));
  assert.ok(positions.length >= bundledPatterns.length);
  assert.equal(positions.length % bundledPatterns.length, 0);
  const normalized = [...rules];
  // The native explore agent repeats the grants in its readonly external-directory block.
  // Normalize only each complete contiguous block of disjoint same-action package grants.
  for (let offset = 0; offset < positions.length; offset += bundledPatterns.length) {
    const block = positions.slice(offset, offset + bundledPatterns.length);
    assert.equal(block.at(-1)! - block[0], bundledPatterns.length - 1);
    const grants = block.map((index) => rules[index]);
    for (const pattern of bundledPatterns) {
      assert.deepEqual(
        grants.filter((rule) => rule.pattern === pattern),
        [{ permission: 'external_directory', pattern, action: 'allow' }],
      );
    }
    const sorted = grants.toSorted((left, right) => left.pattern.localeCompare(right.pattern));
    for (const [index, position] of block.entries()) {
      normalized[position] = sorted[index];
    }
  }
  return normalized;
}
