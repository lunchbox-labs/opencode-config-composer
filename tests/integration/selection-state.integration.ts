import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compositionFixture } from './composition-fixture.ts';

test(
  'project configuration selection survives restart independently, while transient selection resets to configured defaults',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'external-selection');
    const nativeFile = join(f.host.configRoot, 'opencode.jsonc');
    const native = JSON.parse(await readFile(nativeFile, 'utf8')) as {
      agent: { worker: { prompt: string } };
      command?: { audit: { template: string } };
    };
    const prompt = 'NATIVE_WORKER {{include:@shared/guide.md}}';
    const template = 'NATIVE_COMMAND {{include:@shared/command.md}}';
    native.agent.worker.prompt = prompt;
    native.command = { audit: { template } };
    // Avoid the host's one-time schema insertion before checking byte preservation.
    await writeFile(nativeFile, JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...native }));
    const nativeBytes = await readFile(nativeFile, 'utf8');
    const assertNativeContent = async () => {
      const config = await f.host.api<typeof native>('/config');
      assert.equal(config.agent.worker.prompt, prompt, 'configuration selection preserves literal native prompts');
      assert.equal(config.command?.audit.template, template, 'configuration selection preserves native command bodies');
      assert.equal(await readFile(nativeFile, 'utf8'), nativeBytes);
    };
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
    await f.saveScope('project', { operation: 'selection', profiles: ['focus'] });
    await f.editor.reload();
    assert.equal((await f.send()).captured.model, 'alpha');
    await assertNativeContent();
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
    await assertNativeContent();
    assert.ok((await f.history(original.session.id)).some((message) => message.info.id === original.message.info.id));

    await f.write(f.paths.shared, { ...definitions, selection: { defaultProfiles: ['work'], retainOnRestart: false } });
    const transientSourceBytes = await readFile(f.paths.shared, 'utf8');
    await f.editor.reload();
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['work']);
    await f.saveScope('project', { operation: 'selection', profiles: ['focus'] });
    await f.editor.reload();
    assert.equal((await f.send()).captured.model, 'alpha', 'instance rebootstrap preserves process selection');
    await f.host.stop();
    await f.host.start();
    assert.deepEqual((await f.editor.snapshot()).sources.activeProfiles, ['work']);
    assert.equal((await f.send()).captured.model, 'beta', 'fresh server uses configured defaults');
    await assertNativeContent();
    assert.equal(await readFile(f.paths.shared, 'utf8'), transientSourceBytes);
  },
);
