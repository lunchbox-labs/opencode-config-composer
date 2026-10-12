import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';

test(
  'project configuration selection survives restart independently, while transient selection resets to configured defaults',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'external-selection');
    const definitions = {
      componentGroups: {
        work: { agents: ['worker'], configuration: { model: 'fixture/beta' } },
        focus: { agents: ['worker'], configuration: { model: 'fixture/alpha' } },
      },
      profiles: { work: { layers: [{ componentGroup: 'work' }] }, focus: { layers: [{ componentGroup: 'focus' }] } },
    };
    await f.write(f.paths.shared, { ...definitions, selection: { defaultProfiles: ['work'] } });
    await f.host.start();
    const original = await f.send();
    assert.equal(original.captured.model, 'beta');
    const initial = await f.editor.snapshot();
    const path = await f.host.api<{ state: string }>('/path');
    assert.equal(initial.nativeModels.selectionEnvironment?.stateDirectory, path.state);
    const sourceBytes = await readFile(f.paths.shared, 'utf8');
    const nativeBytes = await readFile(join(f.host.configRoot, 'opencode.jsonc'), 'utf8');
    await f.saveScope('project', { operation: 'selection', profiles: ['focus'] });
    await f.editor.reload();
    assert.equal((await f.send()).captured.model, 'alpha');
    const other = join(f.host.root, 'other-project');
    await mkdir(other);
    const response = await fetch(`${f.host.url}/config?directory=${encodeURIComponent(other)}`);
    assert.equal(response.ok, true);
    const otherConfig = (await response.json()) as { agent: { worker: { model: string } } };
    assert.equal(
      otherConfig.agent.worker.model,
      'fixture/beta',
      'shared definitions never share live project selection',
    );
    assert.equal(await readFile(f.paths.shared, 'utf8'), sourceBytes);
    assert.equal(await readFile(join(f.host.configRoot, 'opencode.jsonc'), 'utf8'), nativeBytes);
    await f.host.stop();
    await f.host.start();
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['focus']);
    assert.equal((await f.send()).captured.model, 'alpha');
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));

    await f.write(f.paths.shared, { ...definitions, selection: { defaultProfiles: ['work'], retainOnRestart: false } });
    await f.editor.reload();
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['work']);
    await f.saveScope('project', { operation: 'selection', profiles: ['focus'] });
    await f.editor.reload();
    assert.equal((await f.send()).captured.model, 'alpha', 'instance rebootstrap preserves process selection');
    await f.host.stop();
    await f.host.start();
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['work']);
    assert.equal((await f.send()).captured.model, 'beta', 'fresh server uses configured defaults');
  },
);
