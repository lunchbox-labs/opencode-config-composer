import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compositionFixture } from './integration/composition-fixture.ts';
test(
  'shipped review example applies to native builtin targets and packaged help loads',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'shipped-review');
    await f.write(
      f.paths.shared,
      JSON.parse(
        await readFile(new URL('../docs/examples/review-programming/config-composer.jsonc', import.meta.url), 'utf8'),
      ),
    );
    await f.host.start();
    await f.editor.reload(await f.editor.select('review'));
    const config = await f.host.api<{ agent: { plan: { temperature: number }; explore: { temperature: number } } }>(
      '/config',
    );
    assert.equal(config.agent.plan.temperature, 0);
    assert.equal(config.agent.explore.temperature, 0);
    const skills = await f.host.api<{ name: string }[]>('/skill');
    assert.ok(skills.some((skill) => skill.name === 'config-composer-explain'));
    assert.equal(f.host.requests.length, 0);
  },
);
