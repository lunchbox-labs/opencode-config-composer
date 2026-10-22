import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { nativeHarness } from './harness.ts';
import { installedEditor } from './editor.ts';
export async function compositionFixture(t: TestContext, name: string) {
  const host = await nativeHarness(t, name);
  const paths = {
    shared: join(host.configRoot, 'config-composer.jsonc'),
    native: join(host.configRoot, 'opencode.jsonc'),
  };
  const native = {
    $schema: 'https://opencode.ai/config.json',
    plugin: [host.installed.directory],
    model: 'fixture/alpha',
    small_model: 'fixture/alpha',
    enabled_providers: ['fixture'],
    provider: {
      fixture: {
        name: 'Fixture',
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: host.providerURL, apiKey: 'synthetic' },
        models: Object.fromEntries(
          ['alpha', 'beta'].map((name) => [
            name,
            {
              name: `Fixture ${name}`,
              limit: { context: 8192, output: 256 },
              variants: { high: { reasoningEffort: 'high' } },
            },
          ]),
        ),
      },
    },
    agent: {
      worker: { mode: 'primary', prompt: 'NATIVE_WORKER' },
      helper: { mode: 'subagent', prompt: 'NATIVE_HELPER' },
    },
    command: {
      review: { template: 'NATIVE_REVIEW $ARGUMENTS', agent: 'worker', model: 'fixture/alpha', subtask: true },
    },
  };
  await writeFile(paths.native, JSON.stringify(native));
  await writeFile(join(host.configRoot, 'tui.jsonc'), JSON.stringify({ plugin: [host.installed.directory] }));
  await writeFile(paths.shared, '{}');
  const editor = await installedEditor(host);
  const write = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
  const send = async (agent = 'worker') => {
    const session = await host.api<{ id: string }>('/session', { title: 'Acceptance conversation' });
    const before = host.requests.length;
    const message = await host.api<{ info: { error?: unknown } }>(`/session/${session.id}/message`, {
      agent,
      parts: [{ type: 'text', text: 'Reply briefly.' }],
    });
    assert.equal(message.info.error, undefined);
    const captured = host.requests
      .slice(before)
      .find((request) => request.model === 'alpha' || request.model === 'beta');
    assert.ok(captured !== undefined);
    return { session, message, captured };
  };
  return {
    host,
    paths,
    native,
    editor,
    write,
    send,
    document: async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>,
  };
}
