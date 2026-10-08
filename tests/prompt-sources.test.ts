import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCompositionDocument } from '../src/config-composer/composition/document.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { loadSnapshot, previewFilePlan, saveFilePlan } from '../src/config-composer/storage.ts';
import {
  planPromptAsset,
  planPromptReferences,
  validatePromptAssets,
} from '../src/config-composer/composition/prompt-sources.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-prompt-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'definitions'));
  await mkdir(join(root, 'definitions/snippets'));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  const source = join(root, 'definitions/prompts.jsonc');
  await writeFile(
    source,
    '// retain origin\n' +
      JSON.stringify({
        sourceDirectories: { shared: './snippets' },
        components: {
          prompts: { context: { text: 'Context' } },
          agents: { consumer: { prompt: 'Body', promptRefs: ['context', 'context'] } },
        },
        componentGroups: { work: { agents: ['consumer'], prompts: ['context'] } },
      }),
  );
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      imports: ['./definitions/prompts.jsonc'],
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const save = async (plan: Awaited<ReturnType<typeof planPromptAsset>>) =>
    saveFilePlan(plan, async () => {
      await validatePromptAssets(plan);
    });
  return { root, source, save };
}

test('prompt component rename rewrites ordered references and retains declaring-file paths and comments', async (t) => {
  const f = await fixture(t);
  const snapshot = await loadSnapshot(f.root);
  const plan = await planPromptAsset(snapshot, {
    registry: 'prompts',
    name: 'context',
    operation: 'rename',
    nextName: 'review/context',
  });
  assert.match(plan.consumers.join('\n'), /consumer.*promptRefs/);
  assert.match(plan.consumers.join('\n'), /componentGroups.*work.*prompts/);
  await f.save(plan);
  const saved = await loadSnapshot(f.root);
  assert.deepEqual(saved.sources.registry.components?.agents?.consumer.promptRefs, [
    'review/context',
    'review/context',
  ]);
  assert.equal(saved.resolved.agent.consumer.prompt, 'Body\n\nContext\n\nContext');
  assert.equal(saved.sources.registry.sourceDirectories?.shared, join(f.root, 'definitions/snippets'));
  assert.match(await readFile(f.source, 'utf8'), /retain origin/);
  await assert.rejects(
    planPromptAsset(saved, { registry: 'prompts', name: 'review/context', operation: 'delete' }),
    /referenced.*consumer/s,
  );
  await assert.rejects(
    planPromptAsset(saved, { registry: 'prompts', name: 'review/context', operation: 'rename', nextName: '../unsafe' }),
    /component|property|name/i,
  );
});

test('source aliases rewrite JSONC include consumers without changing escaped literal markers', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'definitions/snippets/context.md'), 'Included');
  let snapshot = await loadSnapshot(f.root);
  await f.save(
    await planPromptAsset(snapshot, {
      registry: 'prompts',
      name: 'context',
      operation: 'set',
      value: { text: '{{include:@shared/context.md}}\n\\{{include:@shared/literal.md}}' },
    }),
  );
  snapshot = await loadSnapshot(f.root);
  const plan = await planPromptAsset(snapshot, {
    registry: 'sourceDirectories',
    name: 'shared',
    operation: 'rename',
    nextName: 'common',
  });
  await f.save(plan);
  const saved = await loadSnapshot(f.root);
  assert.equal(
    saved.sources.registry.components?.prompts?.context.text,
    '{{include:@common/context.md}}\n\\{{include:@shared/literal.md}}',
  );
  assert.match(String(saved.resolved.agent.consumer.prompt), /Included/);
  await assert.rejects(
    planPromptAsset(saved, { registry: 'sourceDirectories', name: 'common', operation: 'delete' }),
    /referenced/,
  );
});

test('new file-backed prompt inputs and nested includes stay guarded through asynchronous save validation', async (t) => {
  const f = await fixture(t);
  const body = join(f.root, 'definitions/body.md');
  const snippet = join(f.root, 'definitions/snippets/context.md');
  await writeFile(body, '{{include:@shared/context.md}}');
  await writeFile(snippet, 'Before');
  const plan = await planPromptAsset(await loadSnapshot(f.root), {
    registry: 'prompts',
    name: 'context',
    operation: 'set',
    value: { file: './body.md' },
  });
  assert.equal((await previewFilePlan(plan)).resolved.agent.consumer.prompt, 'Body\n\nBefore\n\nBefore');
  const original = await readFile(f.source, 'utf8');
  await assert.rejects(
    saveFilePlan(plan, async () => {
      await writeFile(snippet, 'After');
    }),
    /changed/,
  );
  assert.equal(await readFile(f.source, 'utf8'), original);
  await writeFile(snippet, 'Before');
  await writeFile(body, 'Different body');
  await assert.rejects(f.save(plan), /changed/);
  assert.equal(await readFile(f.source, 'utf8'), original);
});

test('alias renames reject nested file consumers without rewriting Markdown', async (t) => {
  const f = await fixture(t);
  const nested = join(f.root, 'definitions/snippets/nested.md');
  await writeFile(nested, '{{include:@shared/context.md}}');
  await writeFile(join(f.root, 'definitions/snippets/context.md'), 'Context');
  await f.save(
    await planPromptAsset(await loadSnapshot(f.root), {
      registry: 'prompts',
      name: 'context',
      operation: 'set',
      value: { text: '{{include:@shared/nested.md}}' },
    }),
  );
  const original = await readFile(f.source, 'utf8');
  await assert.rejects(
    planPromptAsset(await loadSnapshot(f.root), {
      registry: 'sourceDirectories',
      name: 'shared',
      operation: 'rename',
      nextName: 'common',
    }),
    /declaring.*nested\.md|nested\.md.*declaring/s,
  );
  assert.equal(await readFile(f.source, 'utf8'), original);
  assert.equal(await readFile(nested, 'utf8'), '{{include:@shared/context.md}}');
});

test('prompt references can reorder, repeat, reset and reject unavailable components before saving', async (t) => {
  const f = await fixture(t);
  await f.save(
    await planPromptAsset(await loadSnapshot(f.root), {
      registry: 'prompts',
      name: 'second',
      operation: 'create',
      sourceId: f.source,
      value: { text: 'Second' },
    }),
  );
  let plan = await planPromptReferences(await loadSnapshot(f.root), 'consumer', ['second', 'context', 'second']);
  assert.equal((await previewFilePlan(plan)).resolved.agent.consumer.prompt, 'Body\n\nSecond\n\nContext\n\nSecond');
  await f.save(plan);
  await assert.rejects(
    planPromptReferences(await loadSnapshot(f.root), 'consumer', ['missing']),
    /missing|unavailable/,
  );
  plan = await planPromptReferences(await loadSnapshot(f.root), 'consumer', undefined);
  await f.save(plan);
  assert.equal((await loadSnapshot(f.root)).resolved.agent.consumer.prompt, 'Body');
});

test('inactive file-backed agent shorthand counts as a retained Markdown alias consumer', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'definitions/inactive.md'), '---\nmode: subagent\n---\n@shared/context.md\n');
  await writeFile(join(f.root, 'definitions/snippets/context.md'), 'Included');
  const value = parseCompositionDocument(await readFile(f.source, 'utf8'), f.source);
  value.components!.agents!.inactive = { file: './inactive.md' };
  await writeFile(f.source, JSON.stringify(value));
  await assert.rejects(
    planPromptAsset(await loadSnapshot(f.root), {
      registry: 'sourceDirectories',
      name: 'shared',
      operation: 'rename',
      nextName: 'common',
    }),
    /inactive\.md.*declaring/s,
  );
});

test('source-path corrections validate the candidate include graph for inactive consumers', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'definitions/snippets/context.md'), 'Fixed');
  const value = parseCompositionDocument(await readFile(f.source, 'utf8'), f.source);
  value.sourceDirectories!.shared = './missing';
  value.components!.prompts!.inactive = { text: '{{include:@shared/context.md}}' };
  await writeFile(f.source, JSON.stringify(value));
  const plan = await planPromptAsset(await loadSnapshot(f.root), {
    registry: 'sourceDirectories',
    name: 'shared',
    operation: 'set',
    value: './snippets',
  });
  assert.match(plan.consumers.join('\n'), /inactive/);
  await f.save(plan);
  assert.equal(
    (await loadSnapshot(f.root)).sources.registry.sourceDirectories?.shared,
    join(f.root, 'definitions/snippets'),
  );
});

test('read-only prompt consumers reject renames before any JSONC write', async (t) => {
  const f = await fixture(t);
  const reference = join(f.root, 'reference.jsonc');
  await writeFile(reference, '{"components":{"agents":{"external":{"prompt":"External","promptRefs":["context"]}}}}');
  await chmod(reference, 0o444);
  const rootFile = join(f.root, 'config-composer.jsonc');
  const rootValue = parseCompositionDocument(await readFile(rootFile, 'utf8'), rootFile);
  rootValue.imports!.push('./reference.jsonc');
  await writeFile(rootFile, JSON.stringify(rootValue));
  const before = await readFile(f.source, 'utf8');
  await assert.rejects(
    planPromptAsset(await loadSnapshot(f.root), {
      registry: 'prompts',
      name: 'context',
      operation: 'rename',
      nextName: 'new',
    }),
    /Read-only reference/,
  );
  assert.equal(await readFile(f.source, 'utf8'), before);
});

test('new unused aliases guard the selected directory identity until save', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'other'));
  await symlink(join(f.root, 'definitions/snippets'), join(f.root, 'selected'), 'junction');
  const plan = await planPromptAsset(await loadSnapshot(f.root), {
    registry: 'sourceDirectories',
    name: 'unused',
    operation: 'create',
    sourceId: f.source,
    value: '../selected',
  });
  await rm(join(f.root, 'selected'));
  await symlink(join(f.root, 'other'), join(f.root, 'selected'), 'junction');
  await assert.rejects(f.save(plan), /directory changed/);
  assert.equal((await loadSnapshot(f.root)).sources.registry.sourceDirectories?.unused, undefined);
});

test('composed prompt provenance identifies declared bodies, ordered fragments and included files', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'definitions/snippets/context.md'), 'Included');
  await f.save(
    await planPromptAsset(await loadSnapshot(f.root), {
      registry: 'prompts',
      name: 'context',
      operation: 'set',
      value: { text: '{{include:@shared/context.md}}' },
    }),
  );
  const value = parseCompositionDocument(await readFile(f.source, 'utf8'), f.source);
  value.componentGroups!.work.configuration = { prompt: { append: ['Group append'] } };
  await writeFile(f.source, JSON.stringify(value));
  const snapshot = await loadSnapshot(f.root);
  const origin = snapshot.resolved.provenance['/agent/consumer/prompt'];
  assert.equal(origin.operation, 'merge');
  assert.ok(origin.references.includes(`${f.source}#/components/agents/consumer/prompt`));
  assert.ok(origin.references.includes(`${f.source}#/components/prompts/context/text`));
  assert.ok(origin.references.includes(`${f.source}#/componentGroups/work/configuration/prompt/append/0`));
  assert.ok(origin.references.includes(`file:${join(f.root, 'definitions/snippets/context.md')}`));
  value.components!.agents!.consumer.configuration = { prompt: { inheritGroups: false } };
  await writeFile(f.source, JSON.stringify(value));
  const masked = (await loadSnapshot(f.root)).resolved.provenance['/agent/consumer/prompt'];
  assert.ok(!masked.references.some((reference) => reference.includes('/componentGroups/work/configuration/prompt')));
  assert.ok(masked.references.includes(`${f.source}#/components/agents/consumer/configuration/prompt/inheritGroups`));
});

test('native identities that shadow prototype names keep opaque native prompt provenance', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [packageName], agent: { toString: { prompt: 'Native toString body' } } }),
  );
  const value = parseCompositionDocument(await readFile(f.source, 'utf8'), f.source);
  value.componentGroups!.work.agents!.push('toString');
  await writeFile(f.source, JSON.stringify(value));
  const resolved = (await loadSnapshot(f.root)).resolved;
  const native = Object.entries(resolved.agent).find(([name]) => name === 'toString')?.[1];
  assert.equal(native?.prompt, 'Native toString body');
  assert.equal(resolved.provenance['/agent/toString/prompt'].sourceId, undefined);
  assert.deepEqual(resolved.provenance['/agent/toString/prompt'].references, ['native#/agent/toString/prompt']);
});

test('native project alias consumers identify the declaring project JSONC file', async (t) => {
  const f = await fixture(t);
  const project = join(f.root, 'project');
  await mkdir(project);
  const projectFile = join(project, 'opencode.jsonc');
  await writeFile(
    projectFile,
    JSON.stringify({ agent: { 'project-worker': { prompt: '{{include:@shared/context.md}}' } } }),
  );
  await writeFile(join(f.root, 'definitions/snippets/context.md'), 'Context');
  const snapshot = await loadSnapshot(f.root, project);
  await assert.rejects(
    planPromptAsset(snapshot, {
      registry: 'sourceDirectories',
      name: 'shared',
      operation: 'rename',
      nextName: 'common',
    }),
    (error: unknown) =>
      error instanceof Error && error.message.includes(projectFile) && error.message.includes('declaring'),
  );
});
