import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { nativeHarness } from './harness.ts';

/** Only the native host's complete blocks of three disjoint packaged-directory grants may reorder. */
export async function bundledPermissions(host: Awaited<ReturnType<typeof nativeHarness>>) {
  const skills = await host.api<{ name: string; location: string }[]>('/skill');
  const patterns: string[] = [];
  for (const name of ['config-composer-explain', 'config-composer-create', 'config-composer-migrate']) {
    const skill = skills.find((item) => item.name === name);
    assert.ok(skill !== undefined, `native discovery: ${name}`);
    assert.equal(
      await realpath(skill.location),
      await realpath(join(host.installed.directory, 'skills', name, 'SKILL.md')),
    );
    patterns.push(join(dirname(skill.location), '*'));
  }
  return <T extends { permission: string; pattern: string; action: string }>(rules: T[]): T[] => {
    const positions = rules.flatMap((rule, index) => (patterns.includes(rule.pattern) ? [index] : []));
    assert.ok(positions.length >= patterns.length);
    assert.equal(positions.length % patterns.length, 0);
    const normalized = [...rules];
    // Explore repeats the grants in its readonly external-directory block.
    // Preserve block positions/counts, intervening rules and every other policy rule.
    for (let offset = 0; offset < positions.length; offset += patterns.length) {
      const block = positions.slice(offset, offset + patterns.length);
      assert.equal(block.at(-1)! - block[0], patterns.length - 1);
      const grants = block.map((index) => rules[index]);
      for (const pattern of patterns) {
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
  };
}
