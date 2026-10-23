import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';
import { installSkill, nativeSkill } from './permission-fixture.ts';
test(
  'native permission evaluation combines patterns and final authored rules with actual ask replies',
  { timeout: 240000 },
  async (t) => {
    const f = await compositionFixture(t, 'permission-runtime');
    await installSkill(f.host);
    await f.write(f.paths.native, {
      ...f.native,
      agent: {
        ...f.native.agent,
        scalar: { groups: ['scalar'], mode: 'primary', prompt: 'SCALAR_NATIVE' },
        worker: {
          ...f.native.agent.worker,
          permission: { bash: 'allow', skill: { '*': 'deny', 'included-skill': 'deny' }, edit: 'ask' },
        },
      },
    });
    await f.write(f.paths.shared, {
      groups: { scalar: { agent: { permission: 'ask' } } },
      agent: { worker: { permission: { skill: { 'included-skill': 'ask' }, bash: 'deny' } } },
      profiles: {
        whole: { agent: { worker: { permission: 'allow' } } },
        allow: { agent: { worker: { permission: { skill: { 'included-skill': 'allow' } } } } },
        deny: { agent: { worker: { permission: { skill: { 'included-skill': 'deny' } } } } },
      },
    });
    await mkdir(join(f.host.configRoot, 'agents'));
    await writeFile(
      join(f.host.configRoot, 'agents/pinned.md'),
      '---\nmode: primary\npermission:\n  skill: allow\n---\nPinned skill agent',
    );
    await f.host.start();
    const context = await f.editor.context();
    const candidate = await f.editor.storage.previewSelection(context, null);
    assert.deepEqual(Object.keys(candidate.candidate.agent.worker.permission as object), ['edit', 'skill', 'bash']);
    assert.deepEqual((candidate.candidate.agent.worker.permission as Record<string, unknown>).skill, {
      '*': 'deny',
      'included-skill': 'ask',
    });
    const initial = await f.host.api<{ agent: { scalar: { permission: unknown } } }>('/config');
    assert.deepEqual(initial.agent.scalar.permission, { '*': 'ask' });
    await nativeSkill(f.host, 'scalar', 'ask');
    await nativeSkill(f.host, 'worker', 'ask');
    await nativeSkill(f.host, 'pinned', 'allow');
    for (const choice of ['whole', 'allow', 'deny'] as const) {
      const committed = await f.editor.select(choice);
      await f.editor.applySelection(committed);
      if (choice === 'whole') {
        assert.deepEqual(
          (await f.host.api<{ agent: { worker: { permission: unknown } } }>('/config')).agent.worker.permission,
          { edit: 'ask', skill: { '*': 'deny', 'included-skill': 'ask' }, bash: 'deny', '*': 'allow' },
        );
      }
      await nativeSkill(f.host, 'worker', choice === 'whole' ? 'allow' : choice);
      await nativeSkill(f.host, 'pinned', 'allow');
    }
  },
);
