import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { compositionFixture } from './composition-fixture.ts';
import type * as Parameters from '../../src/config-composer/composition/parameter-authoring.ts';
import type * as Review from '../../src/config-composer/composition/parameter-review.ts';
import type * as Permissions from '../../src/config-composer/composition/permission-authoring.ts';
import type * as Prompts from '../../src/config-composer/composition/prompt-authoring.ts';
import type * as Sources from '../../src/config-composer/composition/prompt-sources.ts';
import type * as Settings from '../../src/config-composer/settings.ts';
import type { FilePlan } from '../../src/config-composer/storage.ts';

export async function contentEditor(f: Awaited<ReturnType<typeof compositionFixture>>) {
  const module = (name: string) =>
    pathToFileURL(join(f.host.installed.directory, `dist/config-composer/${name}.js`)).href;
  const parameters = (await import(module('composition/parameter-authoring'))) as typeof Parameters;
  const review = (await import(module('composition/parameter-review'))) as typeof Review;
  const permissions = (await import(module('composition/permission-authoring'))) as typeof Permissions;
  const prompts = (await import(module('composition/prompt-authoring'))) as typeof Prompts;
  const sources = (await import(module('composition/prompt-sources'))) as typeof Sources;
  const settings = (await import(module('settings'))) as typeof Settings;
  const target = async (path: string, label: string) => {
    const snapshot = await f.editor.snapshot();
    const selected = parameters
      .configurationTargets(snapshot, await realpath(path))
      .find((item) => item.label === label);
    assert.ok(selected !== undefined, `Available target: ${label}`);
    return { snapshot, selected };
  };
  const catalog = async () =>
    settings.catalogModels((await f.host.api<{ providers: unknown[] }>('/config/providers')).providers);
  const save = (plan: FilePlan) =>
    f.editor.storage.saveFilePlan(plan, async () => {
      await f.editor.storage.previewFilePlan(plan);
    });
  const saveAsset = (plan: Sources.PromptAssetPlan) =>
    f.editor.storage.saveFilePlan(plan, async () => {
      await sources.validatePromptAssets(plan);
    });
  return { ...parameters, ...review, ...permissions, ...prompts, ...sources, target, catalog, save, saveAsset };
}

export function systemPrompt(captured: Record<string, unknown>): string {
  const messages = captured.messages as { role: string; content: string }[];
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
}
