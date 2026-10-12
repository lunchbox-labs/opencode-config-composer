import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Config } from '@opencode-ai/sdk/v2';
import { compositionFixture } from './composition-fixture.ts';

for (const scenario of ['command-only', 'availability'] as const) {
  test(
    `downstream ${scenario} body changes retain native editor loading and scoped apply`,
    { timeout: 120_000 },
    async (t) => {
      const f = await compositionFixture(t, `body-transform-${scenario}`);
      const nativePath = join(f.host.configRoot, 'opencode.jsonc');
      const native = JSON.parse(await readFile(nativePath, 'utf8')) as Config;
      native.$schema = 'https://opencode.ai/config.json';
      const transformer = join(f.host.root, 'body-transform.mjs');
      await cp(new URL('./fixtures/body-transform.mjs', import.meta.url), transformer);
      native.plugin = [
        f.host.installed.directory,
        [pathToFileURL(transformer).href, { agents: scenario !== 'command-only' }],
      ];
      native.command = { check: { template: 'AUTHORED_COMMAND', agent: 'worker', subtask: true } };
      native.agent = { ...native.agent, dormant: { mode: 'subagent', disable: true, prompt: 'AUTHORED_DORMANT' } };
      const authored = JSON.stringify(native);
      await writeFile(nativePath, authored);
      await f.write(f.paths.shared, {
        profiles: { work: { agentAvailability: { dormant: true } } },
        activeProfiles: ['work'],
      });
      await f.host.start();
      const config = await f.host.api<Config>('/config');
      assert.ok(config.agent?.worker !== undefined && config.agent.dormant !== undefined);
      assert.equal(config.agent.dormant.disable, false);
      assert.equal(
        config.agent.worker.prompt,
        scenario === 'command-only' ? 'NATIVE_WORKER' : 'NATIVE_WORKER\nDOWNSTREAM_AGENT',
      );
      assert.equal(
        config.agent.dormant.prompt,
        scenario === 'command-only' ? 'AUTHORED_DORMANT' : 'AUTHORED_DORMANT\nDOWNSTREAM_AGENT',
      );
      assert.equal(config.command?.check.template, 'AUTHORED_COMMAND\nDOWNSTREAM_COMMAND');
      const snapshot = await f.editor.snapshot();
      assert.ok(snapshot.nativeModels.agent !== undefined);
      assert.equal(snapshot.nativeModels.agent.worker.prompt, 'NATIVE_WORKER');
      assert.equal(snapshot.nativeModels.agent.dormant.disable, true);
      assert.equal(snapshot.nativeModels.agent.dormant.prompt, 'AUTHORED_DORMANT');
      const before = (await f.editor.runtime()).applied;
      await f.saveDefinition({
        operation: 'patch',
        registry: 'profiles',
        name: 'work',
        path: ['agentAvailability'],
        value: { dormant: false },
      });
      const revision = await f.editor.reload();
      const after = (await f.editor.runtime()).applied;
      assert.notEqual(after.id, before.id);
      assert.deepEqual(after.revision, revision);
      assert.notDeepEqual(after.revision, before.revision);
      const disabled = await f.host.api<Config>('/config');
      assert.ok(disabled.agent?.dormant !== undefined);
      assert.equal(disabled.agent.dormant.disable, true);
      assert.equal(disabled.agent.dormant.prompt, 'AUTHORED_DORMANT');
      assert.equal(disabled.command?.check.template, 'AUTHORED_COMMAND\nDOWNSTREAM_COMMAND');
      await f.editor.snapshot();
      if (scenario === 'availability') {
        await f.saveDefinition({
          operation: 'patch',
          registry: 'profiles',
          name: 'work',
          path: ['agentAvailability'],
          value: { dormant: true },
        });
        await f.editor.reload();
        const enabled = await f.host.api<Config>('/config');
        assert.ok(enabled.agent?.dormant !== undefined);
        assert.equal(enabled.agent.dormant.disable, false);
        assert.equal(enabled.agent.dormant.prompt, 'AUTHORED_DORMANT\nDOWNSTREAM_AGENT');
        await f.editor.snapshot();
      }
      assert.equal(await readFile(nativePath, 'utf8'), authored);
      // Authored native-input validation stays strict even though post-hook bodies may change.
      const staleCommand = structuredClone(native);
      assert.ok(staleCommand.command?.check !== undefined);
      staleCommand.command.check.template = 'UNRELOADED_COMMAND_EDIT';
      await writeFile(nativePath, JSON.stringify(staleCommand));
      await assert.rejects(f.editor.reload(), /Native JSON configuration changed.*Restart OpenCode/);
      await writeFile(nativePath, authored);
      const stale = structuredClone(native);
      assert.ok(stale.agent?.worker !== undefined);
      stale.agent.worker.prompt = 'UNRELOADED_NATIVE_EDIT';
      await writeFile(nativePath, JSON.stringify(stale));
      await assert.rejects(f.editor.snapshot(), /Native agent inputs differ/);
    },
  );
}
