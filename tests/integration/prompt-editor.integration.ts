import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compositionFixture } from './composition-fixture.ts';
import { contentEditor, systemPrompt } from './content-editor.ts';
import type { PromptChange } from '../../src/config-composer/composition/prompt-authoring.ts';

test(
  'installed prompt editors preserve exact operations, ordered reusable references and declaring paths in native requests',
  { timeout: 180_000 },
  async (t) => {
    const f = await compositionFixture(t, 'prompt-editing');
    const definitions = join(f.host.configRoot, 'definitions/prompts.jsonc');
    const snippet = join(f.host.configRoot, 'definitions/snippets/context.md');
    await mkdir(join(f.host.configRoot, 'definitions/snippets'), { recursive: true });
    await writeFile(snippet, 'INCLUDED_CONTEXT');
    await writeFile(join(f.host.configRoot, 'definitions/body.md'), 'FILE_BODY');
    await f.write(definitions, {
      sourceDirectories: { notes: './snippets' },
      components: {
        prompts: { context: { text: '{{include:@notes/context.md}}' }, file: { file: './body.md' } },
        agents: { consumer: { mode: 'primary', prompt: 'BASE_BODY', promptRefs: ['context', 'file', 'context'] } },
      },
      componentGroups: {
        work: {
          agents: ['consumer'],
          configuration: { prompt: { prepend: ['GROUP_BEFORE'], append: ['GROUP_AFTER'] } },
        },
      },
    });
    await f.write(f.paths.shared, {
      imports: ['./definitions/prompts.jsonc'],
      defaults: { agents: { prompt: { prepend: ['DEFAULT_BEFORE'], append: ['DEFAULT_AFTER'] } } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    });
    await f.host.start();
    const e = await contentEditor(f);
    const initial = await f.send(undefined, 'consumer');
    const base = 'BASE_BODY\n\nINCLUDED_CONTEXT\n\nFILE_BODY\n\nINCLUDED_CONTEXT';
    assert.ok(
      systemPrompt(initial.captured).includes(
        `DEFAULT_BEFORE\n\nGROUP_BEFORE\n\n${base}\n\nDEFAULT_AFTER\n\nGROUP_AFTER`,
      ),
    );
    const change = async (value: PromptChange) => {
      const { snapshot, selected } = await e.target(definitions, 'Component definition: consumer');
      await e.save(await e.planPrompt(snapshot, selected, value));
    };
    await change({ field: 'append', value: ['FIRST_LINE\nSECOND_LINE', 'FINAL_FRAGMENT'] });
    await change({ field: 'prepend', value: ['LOCAL_FIRST', 'LOCAL_SECOND'] });
    const active = await f.editor.snapshot();
    const composed = String(active.resolved.agent.consumer.prompt);
    assert.match(composed, /LOCAL_FIRST\n\nLOCAL_SECOND/);
    assert.match(composed, /FIRST_LINE\nSECOND_LINE\n\nFINAL_FRAGMENT/);
    const provenance = active.resolved.provenance['/agent/consumer/prompt'];
    assert.ok(provenance.references.includes(`${await realpath(definitions)}#/components/prompts/context/text`));
    assert.ok(provenance.references.includes(`file:${await realpath(snippet)}`));
    assert.ok(!systemPrompt((await f.send(initial.session.id, 'consumer')).captured).includes('LOCAL_FIRST'));
    await f.editor.reload();
    assert.ok(systemPrompt((await f.send(initial.session.id, 'consumer')).captured).includes(composed));
    await change({ field: 'inheritDefaults', value: false });
    await change({ field: 'inheritGroups', value: false });
    await f.editor.reload();
    const excluded = systemPrompt((await f.send(initial.session.id, 'consumer')).captured);
    assert.ok(excluded.includes(`LOCAL_FIRST\n\nLOCAL_SECOND\n\n${base}\n\nFIRST_LINE\nSECOND_LINE\n\nFINAL_FRAGMENT`));
    assert.ok(!/DEFAULT_BEFORE|DEFAULT_AFTER|GROUP_BEFORE|GROUP_AFTER/.test(excluded));
    await change({ field: 'append', value: ['FINAL_FRAGMENT', 'FIRST_LINE\nSECOND_LINE'] });
    await change({ field: 'prepend' });
    await f.editor.reload();
    const reordered = systemPrompt((await f.send(initial.session.id, 'consumer')).captured);
    assert.match(reordered, /FINAL_FRAGMENT\n\nFIRST_LINE\nSECOND_LINE/);
    assert.ok(!reordered.includes('LOCAL_FIRST'));
    await change({ field: 'reset' });
    await e.saveAsset(await e.planPromptReferences(await f.editor.snapshot(), 'consumer', ['file', 'context', 'file']));
    await f.editor.reload();
    const references = systemPrompt((await f.send(initial.session.id, 'consumer')).captured);
    assert.ok(references.includes('BASE_BODY\n\nFILE_BODY\n\nINCLUDED_CONTEXT\n\nFILE_BODY'));
    assert.ok(references.includes('DEFAULT_BEFORE') && references.includes('GROUP_BEFORE'));
    assert.ok(!/FIRST_LINE|LOCAL_FIRST/.test(references));
    const beforeRename = await readFile(f.paths.shared, 'utf8');
    await e.saveAsset(
      await e.planPromptAsset(await f.editor.snapshot(), {
        registry: 'prompts',
        name: 'file',
        operation: 'rename',
        nextName: 'review/body',
      }),
    );
    assert.deepEqual((await f.document(definitions)).components!.agents!.consumer.promptRefs, [
      'review/body',
      'context',
      'review/body',
    ]);
    assert.equal((await f.document(definitions)).components!.prompts!['review/body'].file, './body.md');
    assert.equal(await readFile(f.paths.shared, 'utf8'), beforeRename, 'rename edits declaring JSONC only');
    await assert.rejects(
      e.planPromptAsset(await f.editor.snapshot(), { registry: 'prompts', name: 'review/body', operation: 'delete' }),
      /referenced/,
    );
    await assert.rejects(
      e.planPromptReferences(await f.editor.snapshot(), 'consumer', ['missing']),
      /missing|unavailable/,
    );
    await e.saveAsset(await e.planPromptReferences(await f.editor.snapshot(), 'consumer', ['context']));
    await e.saveAsset(
      await e.planPromptAsset(await f.editor.snapshot(), {
        registry: 'prompts',
        name: 'review/body',
        operation: 'delete',
      }),
    );
    await e.saveAsset(await e.planPromptReferences(await f.editor.snapshot(), 'consumer', undefined));
    await f.editor.reload();
    const reset = systemPrompt((await f.send(initial.session.id, 'consumer')).captured);
    assert.ok(reset.includes('BASE_BODY'));
    assert.ok(!/FILE_BODY|INCLUDED_CONTEXT/.test(reset), 'removed references leave no stale native prompt');
    assert.match(await readFile(definitions, 'utf8'), /Preserve fixture comments/);
    assert.ok((await f.history(initial.session.id)).some((message) => message.info.id === initial.message.info.id));
  },
);

test(
  'installed prompt source plans guard snippets, directory identities and external import consumers before any write',
  { timeout: 180_000 },
  async (t) => {
    const f = await compositionFixture(t, 'prompt-source-guards');
    const definitions = join(f.host.configRoot, 'definitions/prompts.jsonc');
    const directory = join(f.host.configRoot, 'definitions/snippets');
    const snippet = join(directory, 'context.md');
    const body = join(f.host.configRoot, 'definitions/body.md');
    await mkdir(directory, { recursive: true });
    await writeFile(snippet, 'ORIGINAL_SNIPPET');
    await writeFile(body, '{{include:@notes/context.md}}');
    await f.write(definitions, {
      sourceDirectories: { notes: './snippets' },
      components: {
        prompts: { context: { text: '{{include:@notes/context.md}}\n\\{{include:@notes/literal.md}}' } },
        agents: { consumer: { mode: 'primary', prompt: 'BASE', promptRefs: ['context', 'context'] } },
      },
      componentGroups: { work: { agents: ['consumer'] } },
    });
    const consumers = join(f.host.configRoot, 'definitions/consumers.jsonc');
    await f.write(consumers, { components: { prompts: { inactive: { text: '{{include:@notes/context.md}}' } } } });
    await f.write(f.paths.shared, {
      imports: ['./definitions/prompts.jsonc', './definitions/consumers.jsonc'],
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    });
    await f.host.start();
    const e = await contentEditor(f);
    const first = await f.send(undefined, 'consumer');
    await e.saveAsset(
      await e.planPromptAsset(await f.editor.snapshot(), {
        registry: 'sourceDirectories',
        name: 'notes',
        operation: 'rename',
        nextName: 'shared',
      }),
    );
    assert.equal(
      (await f.document(definitions)).components!.prompts!.context.text,
      '{{include:@shared/context.md}}\n\\{{include:@notes/literal.md}}',
    );
    assert.equal((await f.document(consumers)).components!.prompts!.inactive.text, '{{include:@shared/context.md}}');
    assert.match(await readFile(consumers, 'utf8'), /Preserve fixture comments/);
    await f.editor.reload();
    const renamed = systemPrompt((await f.send(first.session.id, 'consumer')).captured);
    assert.equal(renamed.split('ORIGINAL_SNIPPET').length - 1, 2);
    assert.ok(renamed.includes('{{include:@notes/literal.md}}'), 'escaped markers remain literal');
    await assert.rejects(
      e.planPromptAsset(await f.editor.snapshot(), {
        registry: 'sourceDirectories',
        name: 'shared',
        operation: 'delete',
      }),
      /referenced/,
    );
    await writeFile(body, '{{include:@shared/context.md}}');
    const plan = await e.planPromptAsset(await f.editor.snapshot(), {
      registry: 'prompts',
      name: 'context',
      operation: 'set',
      value: { file: './body.md' },
    });
    const before = await readFile(definitions, 'utf8');
    await assert.rejects(
      f.editor.storage.saveFilePlan(plan, async () => {
        await writeFile(snippet, 'CONCURRENT_SNIPPET');
      }),
      /changed/,
    );
    assert.equal(
      await readFile(snippet, 'utf8'),
      'CONCURRENT_SNIPPET',
      'asynchronous validation reached the injected input edit',
    );
    assert.equal(await readFile(definitions, 'utf8'), before);
    await writeFile(snippet, 'ORIGINAL_SNIPPET');
    await writeFile(body, 'CHANGED_BODY');
    await assert.rejects(e.saveAsset(plan), /changed/);
    assert.equal(await readFile(definitions, 'utf8'), before);
    await writeFile(body, '{{include:@shared/context.md}}');
    await e.saveAsset(
      await e.planPromptAsset(await f.editor.snapshot(), {
        registry: 'prompts',
        name: 'context',
        operation: 'set',
        value: { file: './body.md' },
      }),
    );
    await f.editor.reload();
    const filePrompt = systemPrompt((await f.send(first.session.id, 'consumer')).captured);
    assert.ok(filePrompt.includes('BASE\n\nORIGINAL_SNIPPET\n\nORIGINAL_SNIPPET'));
    assert.ok(!filePrompt.includes('literal.md'));
    const fileBacked = await readFile(definitions, 'utf8');
    await assert.rejects(
      e.planPromptAsset(await f.editor.snapshot(), {
        registry: 'sourceDirectories',
        name: 'shared',
        operation: 'rename',
        nextName: 'common',
      }),
      /body\.md.*declaring|declaring.*body\.md/s,
    );
    assert.equal(await readFile(definitions, 'utf8'), fileBacked);
    assert.equal(await readFile(body, 'utf8'), '{{include:@shared/context.md}}');
    const external = join(f.host.root, 'external-consumer.jsonc');
    await f.write(external, { components: { agents: { external: { prompt: 'EXTERNAL', promptRefs: ['context'] } } } });
    const shared = await f.document(f.paths.shared);
    shared.imports!.push(external.replaceAll('\\', '/'));
    await f.write(f.paths.shared, shared);
    const externalBytes = await readFile(external, 'utf8');
    await assert.rejects(
      e.planPromptAsset(await f.editor.snapshot(), {
        registry: 'prompts',
        name: 'context',
        operation: 'rename',
        nextName: 'renamed',
      }),
      /Read-only reference/,
    );
    assert.equal(await readFile(external, 'utf8'), externalBytes);
    assert.equal(await readFile(definitions, 'utf8'), fileBacked);
    const alternate = join(f.host.configRoot, 'alternate');
    const selected = join(f.host.configRoot, 'selected');
    await mkdir(alternate);
    await symlink(directory, selected, 'junction');
    const redirected = await e.planPromptAsset(await f.editor.snapshot(), {
      registry: 'sourceDirectories',
      name: 'unused',
      operation: 'create',
      sourceId: await realpath(definitions),
      value: '../selected',
    });
    await rm(selected);
    await symlink(alternate, selected, 'junction');
    await assert.rejects(e.saveAsset(redirected), /directory changed/);
    assert.equal(await readFile(definitions, 'utf8'), fileBacked);
    assert.equal((await f.document(definitions)).sourceDirectories!.unused, undefined);
    await e.saveAsset(
      await e.planPromptAsset(await f.editor.snapshot(), {
        registry: 'sourceDirectories',
        name: 'unused',
        operation: 'create',
        sourceId: await realpath(definitions),
        value: '../alternate',
      }),
    );
    await e.saveAsset(
      await e.planPromptAsset(await f.editor.snapshot(), {
        registry: 'sourceDirectories',
        name: 'unused',
        operation: 'set',
        value: './snippets',
      }),
    );
    await e.saveAsset(
      await e.planPromptAsset(await f.editor.snapshot(), {
        registry: 'sourceDirectories',
        name: 'unused',
        operation: 'delete',
      }),
    );
    assert.equal((await f.document(definitions)).sourceDirectories!.unused, undefined);
    assert.match(await readFile(definitions, 'utf8'), /Preserve fixture comments/);
    assert.ok((await f.history(first.session.id)).some((message) => message.info.id === first.message.info.id));
  },
);
