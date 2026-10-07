import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { nativeHarness } from './harness.ts';
import { installedEditor } from './editor.ts';
import type * as Authoring from '../../src/config-composer/composition/authoring.ts';
import type * as Activation from '../../src/config-composer/composition/activation.ts';
import type { CompositionDocument } from '../../src/config-composer/composition/document-types.ts';

export interface NativeMessage {
  info: { id: string; modelID: string; error?: unknown };
  parts: { type: string; text?: string }[];
}

export async function compositionFixture(t: TestContext, name: string) {
  const host = await nativeHarness(t, name);
  const editor = await installedEditor(host);
  const module = (name: string) =>
    pathToFileURL(join(host.installed.directory, `dist/config-composer/composition/${name}.js`)).href;
  const authoring = (await import(module('authoring'))) as typeof Authoring;
  const activation = (await import(module('activation'))) as typeof Activation;
  const paths = {
    shared: join(host.configRoot, 'config-composer.jsonc'),
    project: join(host.project, '.opencode/config-composer.jsonc'),
    local: join(host.project, '.opencode/config-composer.local.jsonc'),
  };
  const model = (name: string) => ({
    name,
    temperature: true,
    limit: { context: 8192, output: 256 },
    variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } },
  });
  await writeFile(
    join(host.configRoot, 'opencode.jsonc'),
    JSON.stringify({
      plugin: [host.installed.directory],
      model: 'fixture/alpha',
      small_model: 'fixture/alpha',
      default_agent: 'worker',
      enabled_providers: ['fixture'],
      provider: {
        fixture: {
          name: 'Local acceptance provider',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: host.providerURL, apiKey: 'synthetic-test-key' },
          models: { alpha: model('Fixture Alpha'), beta: model('Fixture Beta') },
        },
      },
      agent: { worker: { mode: 'primary', prompt: 'NATIVE_WORKER' } },
    }),
  );
  await writeFile(join(host.configRoot, 'tui.jsonc'), JSON.stringify({ plugin: [host.installed.directory] }));
  const write = async (path: string, value: CompositionDocument) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `// Preserve fixture comments\n${JSON.stringify(value, null, 2)}\n`);
  };
  const document = async (path: string) => parse(await readFile(path, 'utf8')) as CompositionDocument;
  const saveDefinition = async (change: Authoring.DefinitionChange) => {
    const plan = authoring.planDefinition(
      await editor.snapshot(),
      change.operation === 'create' ? { ...change, sourceId: await realpath(change.sourceId) } : change,
    );
    const preview = await authoring.previewDefinition(plan);
    await editor.storage.saveFilePlan(plan, async () => {
      await authoring.previewDefinition(plan);
    });
    return { plan, preview };
  };
  const saveScope = async (scope: Activation.CompositionScope, change: Activation.ScopeChange) => {
    const plan = activation.planScope(await editor.snapshot(), scope, change);
    const preview = await editor.storage.previewFilePlan(plan);
    await editor.storage.saveFilePlan(plan, async () => {
      await editor.storage.previewFilePlan(plan);
    });
    return { plan, preview };
  };
  const send = async (sessionID?: string, agent = 'worker') => {
    const session =
      sessionID === undefined
        ? await host.api<{ id: string }>('/session', { title: 'Acceptance conversation' })
        : { id: sessionID };
    const before = host.requests.length;
    const message = await host.api<NativeMessage>(`/session/${session.id}/message`, {
      agent,
      parts: [{ type: 'text', text: 'Reply with verified.' }],
    });
    assert.equal(message.info.error, undefined, JSON.stringify(message.info.error));
    assert.ok(message.parts.some((part) => part.text === 'verified'));
    assert.equal(host.requests.length, before + 1, 'one native dispatch reaches the local provider');
    return { session, message, captured: host.requests.at(-1)! };
  };
  const history = (id: string) => host.api<NativeMessage[]>(`/session/${id}/message`);
  return { host, editor, authoring, activation, paths, write, document, saveDefinition, saveScope, send, history };
}
