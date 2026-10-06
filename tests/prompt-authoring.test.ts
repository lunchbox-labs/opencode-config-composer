import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageName } from '../src/config-composer/package-name.ts';
import {
  collectFileReads,
  loadSnapshot,
  planChange,
  plannedChoices,
  previewFilePlan,
  saveFilePlan,
  savePlan,
} from '../src/config-composer/storage.ts';
import { planPrompt, promptTargets, promptValue } from '../src/config-composer/composition/prompt-authoring.ts';

test('changes to an included prompt invalidate a captured editor snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-prompt-editor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'snippets'));
  await writeFile(join(root, 'snippets/context.md'), 'First');
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [packageName], agent: { worker: { prompt: 'Worker' } } }),
  );
  const path = join(root, 'config-composer.jsonc');
  const original = JSON.stringify({
    sourceDirectories: { shared: './snippets' },
    componentGroups: {
      work: {
        agents: ['worker'],
        configuration: { model: 'fixture/first', prompt: { append: ['@shared/context.md'] } },
      },
    },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  await writeFile(path, original);
  const snapshot = await loadSnapshot(root);
  const plan = planChange(snapshot, { kind: 'group', name: 'work', choice: { model: 'fixture/next' } });
  await writeFile(join(root, 'snippets/context.md'), 'Changed');
  await assert.rejects(savePlan(plan), /changed/i);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('prompt plans preserve multiline order and siblings, and guard newly referenced inputs across validation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-prompt-plans-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'snippets'));
  const included = join(root, 'snippets/new.md');
  await writeFile(included, 'Included');
  const native = JSON.stringify({ plugin: [packageName], agent: { worker: { prompt: 'Base' } } });
  await writeFile(join(root, 'opencode.jsonc'), native);
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    '// Retain\n' +
      JSON.stringify({
        sourceDirectories: { shared: './snippets' },
        defaults: { agents: { prompt: { prepend: ['Default'] } } },
        componentGroups: {
          work: { agents: ['worker'], configuration: { model: 'fixture/model', parameters: { topP: 0.7 } } },
        },
        profiles: { work: { layers: [{ componentGroup: 'work' }] } },
        activeProfiles: ['work'],
      }),
  );
  let snapshot = await loadSnapshot(root);
  let target = promptTargets(snapshot, path).find((target) => target.label === 'Group: work')!;
  const plan = await planPrompt(snapshot, target, { field: 'append', value: ['First\nSecond', '@shared/new.md'] });
  assert.equal(
    (await previewFilePlan(plan)).resolved.agent.worker.prompt,
    'Default\n\nBase\n\nFirst\nSecond\n\nIncluded',
  );
  await assert.rejects(
    saveFilePlan(plan, async () => {
      await writeFile(included, 'Changed');
    }),
    /changed/i,
  );
  assert.equal(promptValue(await loadSnapshot(root), target).append, undefined);
  await writeFile(included, 'Included');
  await saveFilePlan(plan, async () => {
    await previewFilePlan(plan);
  });
  snapshot = await loadSnapshot(root);
  target = promptTargets(snapshot, path).find((target) => target.label === 'Agent override: worker')!;
  const inheritance = await planPrompt(snapshot, target, { field: 'inheritDefaults', value: false });
  assert.equal((await previewFilePlan(inheritance)).resolved.agent.worker.prompt, 'Base\n\nFirst\nSecond\n\nIncluded');
  assert.match(await readFile(path, 'utf8'), /Retain/);
  assert.equal(await readFile(join(root, 'opencode.jsonc'), 'utf8'), native);
  assert.deepEqual(snapshot.sources.registry.componentGroups?.work.configuration?.parameters, { topP: 0.7 });
  await assert.rejects(
    planPrompt(snapshot, target, { field: 'prepend', value: ['{{include:@shared/missing.md}}'] }),
    /Could not read/,
  );
  await assert.rejects(planPrompt(snapshot, { ...target, path: ['plugin'] }, { field: 'reset' }), /target|destination/);
});

test('membership previews retain newly activated include inputs until save', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-membership-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'snippets'));
  const snippet = join(root, 'snippets/context.md');
  await writeFile(snippet, 'Before');
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [packageName], agent: { worker: { prompt: 'Worker' } } }),
  );
  const path = join(root, 'config-composer.jsonc');
  const original = JSON.stringify({
    sourceDirectories: { shared: './snippets' },
    componentGroups: { work: { agents: [], configuration: { prompt: { append: ['@shared/context.md'] } } } },
    profiles: { work: { layers: [{ componentGroup: 'work' }] } },
    activeProfiles: ['work'],
  });
  await writeFile(path, original);
  const plan = planChange(await loadSnapshot(root), { kind: 'membership', agent: 'worker', groups: ['work'] });
  await plannedChoices(plan);
  await writeFile(snippet, 'After');
  await assert.rejects(savePlan(plan), /changed/i);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('included files use candidate edits while retaining disk bytes for freshness', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-overlaid-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agents'));
  const reviewer = join(root, 'agents/reviewer.md');
  const original = '---\nmodel: fixture/old\n---\nReviewer body';
  await writeFile(reviewer, original);
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [packageName], agent: { worker: { prompt: 'Worker' } } }),
  );
  await writeFile(
    join(root, 'config-composer.jsonc'),
    JSON.stringify({
      sourceDirectories: { agents: './agents' },
      defaults: { agents: { prompt: { append: ['@agents/reviewer.md'] } } },
      componentGroups: { work: { agents: ['worker', 'reviewer'] } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const snapshot = await loadSnapshot(root);
  const plan = planChange(snapshot, { kind: 'override', agent: 'reviewer', choice: { model: 'fixture/new' } });
  const preview = await previewFilePlan(plan);
  assert.match(String(preview.resolved.agent.worker.prompt), /fixture\/new/);
  assert.equal(preview.reads.find((file) => file.path === reviewer)?.text, original);
  await savePlan(plan);
  const saved = await loadSnapshot(root);
  assert.equal(saved.resolved.agent.worker.prompt, preview.resolved.agent.worker.prompt);
});

test('repeated includes retain one raw input per canonical file across previews', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'composer-repeated-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'snippets'));
  const snippet = join(root, 'snippets/space.md');
  await writeFile(snippet, ' '.repeat(64 * 1024));
  await writeFile(
    join(root, 'opencode.jsonc'),
    JSON.stringify({ plugin: [packageName], agent: { worker: { prompt: 'Worker' } } }),
  );
  const path = join(root, 'config-composer.jsonc');
  await writeFile(
    path,
    JSON.stringify({
      sourceDirectories: { shared: './snippets' },
      componentGroups: { work: { agents: ['worker'] } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    }),
  );
  const snapshot = await loadSnapshot(root);
  const target = promptTargets(snapshot, path).find((target) => target.label === 'Agent override: worker')!;
  const plan = await planPrompt(snapshot, target, {
    field: 'append',
    value: Array.from({ length: 256 }, () => '@shared/space.md'),
  });
  await previewFilePlan(plan);
  assert.equal(plan.reads?.length, 1);
  assert.equal(plan.reads[0].text.length, 64 * 1024);
  await saveFilePlan(plan, async () => {
    await previewFilePlan(plan);
  });
  assert.equal((await loadSnapshot(root)).files.filter((file) => file.path === snippet).length, 1);
});

test('input collection preserves aliases and rejects changed bytes or identity', () => {
  const input = {
    path: '/snippets/one.md',
    canonicalPath: '/actual/one.md',
    text: 'One',
    mode: 0o600,
    writable: false,
  };
  const reads = collectFileReads([input]);
  reads.read({ ...input, path: '/alias/one.md' });
  reads.read({ ...input, path: '/alias/one.md' });
  assert.equal(reads.files.length, 1);
  assert.deepEqual(reads.files[0].aliases, ['/alias/one.md']);
  assert.throws(() => reads.read({ ...input, text: 'Two' }), /changed/);
  assert.throws(() => reads.read({ ...input, canonicalPath: '/actual/two.md' }), /changed identity/);
});

test('inactive prompt plans retain every source-directory identity even when file aliases share a target', async (t) => {
  if (process.platform === 'win32') {
    t.skip('file symlink creation requires Windows privileges');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'composer-prompt-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'a'));
  await mkdir(join(root, 'b'));
  await writeFile(join(root, 'a/x.md'), 'Fragment');
  await symlink(join(root, 'a/x.md'), join(root, 'b/x.md'));
  await symlink(join(root, 'a'), join(root, 'selected'));
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({ plugin: [packageName] }));
  const path = join(root, 'config-composer.jsonc');
  const original = JSON.stringify({
    sourceDirectories: { first: './a', selected: './selected' },
    componentGroups: { inactive: {} },
  });
  await writeFile(path, original);
  const snapshot = await loadSnapshot(root);
  const target = promptTargets(snapshot, path).find((target) => target.label === 'Group: inactive')!;
  const plan = await planPrompt(snapshot, target, { field: 'append', value: ['@first/x.md', '@selected/x.md'] });
  assert.equal(plan.reads?.length, 1);
  await rm(join(root, 'selected'));
  await symlink(join(root, 'b'), join(root, 'selected'));
  await assert.rejects(
    saveFilePlan(plan, async () => {
      await previewFilePlan(plan);
    }),
    /changed.*directory|directory.*changed/i,
  );
  assert.equal(await readFile(path, 'utf8'), original);
});
