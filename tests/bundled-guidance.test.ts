import { test } from 'node:test';
import { validateBundledSkills } from '../src/config-composer/bundled-skills.ts';

test('bundled skills have valid identities, frontmatter and loadable resources', async () => {
  await validateBundledSkills();
});
