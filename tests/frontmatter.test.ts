import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { type TestContext, test } from 'node:test';
import matter from 'gray-matter';
import { readNativeAgentFrontmatter } from '../src/config-composer/frontmatter.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'composer-frontmatter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const directory = join(project, 'nested');
  const global = join(root, 'config/opencode');
  const near = join(directory, '.opencode');
  const worktree = join(project, '.opencode');
  const homeConfig = join(home, '.opencode');
  const custom = join(root, 'custom');
  await mkdir(directory, { recursive: true });
  const environment: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: join(root, 'config'), OPENCODE_CONFIG_DIR: custom };
  const context = { directory, worktree: project, home, environment };
  async function markdown(root: string, name: string, frontmatter: string, body = 'Opaque native body.') {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `---\n${frontmatter}\n---\n${body}`);
    return path;
  }
  return { root, home, global, near, worktree, homeConfig, custom, context, markdown };
}

test('native authored sources follow lexical global, nearest project, worktree, home, and custom order', async (t) => {
  const f = await fixture(t);
  const roots = [f.global, f.near, f.worktree, f.homeConfig, f.custom];
  const paths = [];
  for (const [index, root] of roots.entries()) {
    paths.push(await f.markdown(root, 'agents/shared.md', `model: fixture/${index}`));
    await f.markdown(root, `agents/marker-${index}.md`, 'temperature: 0');
  }
  await f.markdown(f.near, 'agents/project.md', 'model: fixture/near\nvariant: near');
  const projectPath = await f.markdown(f.worktree, 'agents/project.md', 'model: fixture/worktree');
  const explicit = join(f.root, 'explicit');
  await f.markdown(explicit, 'agents/not-discovered.md', 'model: fixture/unscanned');
  f.context.environment.OPENCODE_CONFIG = join(explicit, 'opencode.json');
  const agents = await readNativeAgentFrontmatter(f.context);
  assert.equal(agents.get('shared')?.fields.model?.value, 'fixture/4');
  assert.deepEqual(
    agents.get('shared')?.sources.map((source) => source.path),
    paths,
  );
  assert.equal(agents.get('project')?.fields.model?.source.path, projectPath);
  assert.equal(agents.get('project')?.fields.variant?.value, 'near');
  assert.equal(agents.has('not-discovered'), false);
  for (const index of roots.keys()) {
    assert.equal(agents.has(`marker-${index}`), true);
  }
});

test('project disable is case insensitive and retains HOME and explicit config directories', async (t) => {
  const f = await fixture(t);
  for (const [name, root] of Object.entries({
    global: f.global,
    near: f.near,
    worktree: f.worktree,
    home: f.homeConfig,
    custom: f.custom,
  })) {
    await f.markdown(root, `agents/${name}.md`, 'model: fixture/test');
  }
  f.context.environment.OPENCODE_DISABLE_PROJECT_CONFIG = 'TRUE';
  assert.deepEqual([...(await readNativeAgentFrontmatter(f.context)).keys()].sort(), ['custom', 'global', 'home']);
});

test('native relative XDG and explicit roots resolve against process cwd with lexical source paths', async (t) => {
  const f = await fixture(t);
  await f.markdown(f.global, 'agents/global.md', 'model: fixture/global');
  await f.markdown(f.custom, 'agents/custom.md', 'model: fixture/custom');
  f.context.environment.XDG_CONFIG_HOME = relative(process.cwd(), dirname(f.global));
  f.context.environment.OPENCODE_CONFIG_DIR = relative(process.cwd(), f.custom);
  const agents = await readNativeAgentFrontmatter(f.context);
  assert.equal(
    agents.get('global')?.fields.model?.source.path,
    join(f.context.environment.XDG_CONFIG_HOME, 'opencode/agents/global.md'),
  );
  assert.equal(
    agents.get('custom')?.fields.model?.source.path,
    join(f.context.environment.OPENCODE_CONFIG_DIR, 'agents/custom.md'),
  );
  assert.equal(agents.get('custom')?.fields.model?.source.canonicalPath, join(f.custom, 'agents/custom.md'));
});

test('native test home affects .opencode discovery while OS home still supplies the XDG fallback', async (t) => {
  const f = await fixture(t);
  const testHome = join(f.root, 'test-home');
  await f.markdown(join(f.home, '.config/opencode'), 'agents/xdg-fallback.md', 'model: fixture/fallback');
  await f.markdown(f.homeConfig, 'agents/actual-home.md', 'model: fixture/actual');
  await f.markdown(join(testHome, '.opencode'), 'agents/test-home.md', 'model: fixture/test');
  delete f.context.environment.XDG_CONFIG_HOME;
  f.context.environment.OPENCODE_TEST_HOME = testHome;
  const agents = await readNativeAgentFrontmatter(f.context);
  assert.equal(agents.has('xdg-fallback'), true);
  assert.equal(agents.has('test-home'), true);
  assert.equal(agents.has('actual-home'), false);
});

test('native non-Git worktree sentinel searches lexical ancestors through the filesystem root', async (t) => {
  const f = await fixture(t);
  const ancestor = await f.markdown(join(f.root, '.opencode'), 'agents/ancestor.md', 'model: fixture/ancestor');
  const fields = (await readNativeAgentFrontmatter({ ...f.context, worktree: '/' })).get('ancestor')!.fields;
  assert.equal(fields.model?.source.path, ancestor);
});

test('lexically duplicate roots are read once without canonical deduplication of symlink roots', async (t) => {
  const f = await fixture(t);
  await f.markdown(f.global, 'agents/shared.md', 'model: fixture/global');
  await f.markdown(f.homeConfig, 'agents/shared.md', 'model: fixture/home');
  f.context.environment.OPENCODE_CONFIG_DIR = f.global;
  let shared = (await readNativeAgentFrontmatter(f.context)).get('shared')!;
  assert.equal(shared.fields.model?.value, 'fixture/home');
  assert.equal(shared.sources.length, 2);
  await symlink(f.global, f.custom, 'dir');
  f.context.environment.OPENCODE_CONFIG_DIR = f.custom;
  shared = (await readNativeAgentFrontmatter(f.context)).get('shared')!;
  assert.equal(shared.fields.model?.value, 'fixture/global');
  assert.equal(shared.sources.length, 3);
  assert.equal(shared.fields.model.source.path, join(f.custom, 'agents/shared.md'));
  assert.equal(shared.fields.model.source.canonicalPath, join(f.global, 'agents/shared.md'));
});

test('authored field entries preserve explicit empty, false, and zero values without baseline inference', async (t) => {
  const f = await fixture(t);
  await f.markdown(
    f.global,
    'agents/explicit.md',
    'model: ""\nvariant: ""\ntemperature: 0\ntop_p: 0\noptions: {}\npermission: {}\ndisable: false',
  );
  await f.markdown(f.global, 'agents/false.md', 'options:\n  enabled: false');
  const agents = await readNativeAgentFrontmatter(f.context);
  const fields = agents.get('explicit')!.fields;
  assert.deepEqual(Object.fromEntries(Object.entries(fields).map(([name, pin]) => [name, pin.value])), {
    model: '',
    variant: '',
    temperature: 0,
    top_p: 0,
    options: {},
    permission: {},
  });
  assert.deepEqual(fields.options?.authored, { options: {} });
  assert.deepEqual(fields.permission?.authored, { permission: {} });
  assert.equal(Object.hasOwn(fields, 'mode'), false);
  assert.deepEqual(agents.get('false')?.fields.options?.value, { enabled: false });
});

test('scalar permissions and legacy tools retain their raw authored values with native normalization', async (t) => {
  const f = await fixture(t);
  await f.markdown(f.global, 'agents/scalar.md', 'permission: deny');
  await f.markdown(
    f.global,
    'agents/legacy.md',
    'tools:\n  write: false\n  edit: true\n  patch: false\n  multiedit: true\n  bash: true\npermission:\n  bash: ask',
  );
  const agents = await readNativeAgentFrontmatter(f.context);
  assert.deepEqual(agents.get('scalar')?.fields.permission?.value, { '*': 'deny' });
  assert.deepEqual(agents.get('scalar')?.fields.permission?.authored, { permission: 'deny' });
  const permission = agents.get('legacy')?.fields.permission;
  assert.deepEqual(permission?.value, { edit: 'deny', multiedit: 'allow', bash: 'ask' });
  assert.deepEqual(permission.authored, {
    tools: { write: false, edit: true, patch: false, multiedit: true, bash: true },
    permission: { bash: 'ask' },
  });
});

test('steps pins follow native per-source steps or deprecated maxSteps normalization', async (t) => {
  const f = await fixture(t);
  await f.markdown(f.global, 'agents/current.md', 'steps: 3\nmaxSteps: 9');
  await f.markdown(f.global, 'agents/deprecated.md', 'maxSteps: 4');
  await f.markdown(f.global, 'agents/replaced.md', 'steps: 5');
  await f.markdown(f.custom, 'agents/replaced.md', 'maxSteps: 2');
  await f.markdown(f.global, 'agents/retained.md', 'maxSteps: 6');
  await f.markdown(f.custom, 'agents/retained.md', 'model: fixture/later');
  await f.markdown(f.global, 'agents/absent.md', 'model: fixture/only');
  const agents = await readNativeAgentFrontmatter(f.context);
  const steps = (name: string) => {
    const pin = agents.get(name)?.fields.steps;
    return pin === undefined ? undefined : { value: pin.value, authored: pin.authored, path: pin.source.path };
  };
  assert.deepEqual(steps('current'), {
    value: 3,
    authored: { steps: 3, maxSteps: 9 },
    path: join(f.global, 'agents/current.md'),
  });
  assert.deepEqual(steps('deprecated'), {
    value: 4,
    authored: { maxSteps: 4 },
    path: join(f.global, 'agents/deprecated.md'),
  });
  assert.deepEqual(steps('replaced'), {
    value: 2,
    authored: { maxSteps: 2 },
    path: join(f.custom, 'agents/replaced.md'),
  });
  assert.deepEqual(steps('retained'), {
    value: 6,
    authored: { maxSteps: 6 },
    path: join(f.global, 'agents/retained.md'),
  });
  assert.equal(steps('absent'), undefined);
});

test('native option relocation keeps raw inputs and excludes native agent schema fields', async (t) => {
  const f = await fixture(t);
  await f.markdown(
    f.global,
    'agents/options.md',
    'name: renamed\ndescription: Native description\nmodel: fixture/a\nmode: all\ndisable: false\nhidden: false\ncolor: "#ff0000"\nmaxSteps: 7\nsteps: 8\noptions:\n  reasoningEffort: low\nreasoningEffort: high\ncustom: false',
  );
  const agent = (await readNativeAgentFrontmatter(f.context)).get('renamed')!;
  assert.deepEqual(agent.fields.options?.value, { reasoningEffort: 'high', custom: false });
  assert.deepEqual(agent.fields.options.authored, {
    options: { reasoningEffort: 'low' },
    reasoningEffort: 'high',
    custom: false,
  });
  assert.equal(Object.hasOwn(agent.fields, 'description'), false);
});

test('pinned options and permissions use explicit later whole-field values including empty objects', async (t) => {
  const f = await fixture(t);
  await f.markdown(
    f.global,
    'agents/shared.md',
    'model: fixture/earlier\noptions:\n  earlier: true\npermission:\n  bash: deny',
  );
  await f.markdown(f.custom, 'agents/shared.md', 'options: {}\npermission: {}');
  const fields = (await readNativeAgentFrontmatter(f.context)).get('shared')!.fields;
  assert.equal(fields.model?.value, 'fixture/earlier');
  assert.deepEqual(fields.options?.value, {});
  assert.deepEqual(fields.permission?.value, {});
});

test('native YAML aliases, colon fallback, JSON engines, and literal substitutions are preserved', async (t) => {
  const f = await fixture(t);
  await f.markdown(
    f.global,
    'agents/alias.md',
    'defaults: &defaults\n  model: fixture/alias\n  temperature: 0\n<<: *defaults',
  );
  await f.markdown(f.global, 'agents/fallback.md', 'description: hello: world\nmodel: fixture/fallback');
  await f.markdown(f.global, 'agents/literal.md', 'model: "{env:MODEL}"\noptions:\n  note: "{file:note.txt}"');
  const json = join(f.global, 'agents/json.md');
  await writeFile(json, '---json\n{"model":"fixture/json","temperature":0}\n---\nNative body.');
  const agents = await readNativeAgentFrontmatter(f.context);
  assert.equal(agents.get('alias')?.fields.model?.value, 'fixture/alias');
  assert.equal(agents.get('alias')?.fields.temperature?.value, 0);
  assert.equal(agents.get('fallback')?.fields.model?.value, 'fixture/fallback');
  assert.equal(agents.get('literal')?.fields.model?.value, '{env:MODEL}');
  assert.deepEqual(agents.get('literal')?.fields.options?.value, { note: '{file:note.txt}' });
  assert.equal(agents.get('json')?.fields.model?.value, 'fixture/json');
});

test('unsupported frontmatter engines fail without executing authored content', async (t) => {
  const f = await fixture(t);
  const marker = `composer-frontmatter-marker-${Date.now()}`;
  for (const language of ['javascript', 'js', 'custom']) {
    const path = await f.markdown(f.global, 'agents/unsafe.md', 'model: fixture/a');
    await writeFile(
      path,
      `---${language}\n(globalThis[${JSON.stringify(marker)}] = true, { model: 'fixture/unsafe' })\n---\nOpaque body.`,
    );
    await assert.rejects(readNativeAgentFrontmatter(f.context), /unsafe\.md.*unsupported.*engine/i);
    assert.equal(Reflect.has(globalThis, marker), false);
  }
});

test('native recursive agent paths include dotfiles and symlinks; flat modes force primary', async (t) => {
  const f = await fixture(t);
  await f.markdown(f.global, 'agent/nested/deep.md', 'model: fixture/deep');
  await f.markdown(f.global, 'agents/.hidden.md', 'model: fixture/dot');
  const external = await f.markdown(f.root, 'external/outside.md', 'name: linked\nmodel: fixture/symlink');
  await symlink(dirname(external), join(f.global, 'agents/linked-directory'), 'dir');
  await symlink(external, join(f.global, 'agents/file-link.md'));
  await f.markdown(f.global, 'modes/flat.md', 'mode: subagent\nmodel: fixture/flat');
  await f.markdown(f.global, 'mode/default.md', 'model: fixture/default');
  await f.markdown(f.global, 'modes/nested/ignored.md', 'model: fixture/ignored');
  // The directory and file aliases above deliberately share the same native name.
  await assert.rejects(
    readNativeAgentFrontmatter(f.context),
    /ambiguous.*linked.*file-link\.md.*linked-directory|ambiguous.*linked.*linked-directory.*file-link\.md/is,
  );
  await rm(join(f.global, 'agents/file-link.md'));
  const agents = await readNativeAgentFrontmatter(f.context);
  assert.equal(agents.get('nested/deep')?.fields.model?.value, 'fixture/deep');
  assert.equal(agents.get('.hidden')?.fields.model?.value, 'fixture/dot');
  assert.equal(agents.get('linked')?.fields.model?.source.canonicalPath, external);
  assert.equal(agents.has('nested/ignored'), false);
  assert.equal(agents.get('flat')?.fields.mode?.value, 'primary');
  assert.deepEqual(agents.get('flat')?.fields.mode?.authored, { mode: 'subagent' });
  assert.equal(Object.hasOwn(agents.get('default')!.fields, 'mode'), false);
});

test('native dotfiles named exactly .md keep their full root and nested identities', async (t) => {
  const f = await fixture(t);
  const dot = await f.markdown(f.global, 'agents/.md', 'model: fixture/dot');
  const nested = await f.markdown(f.global, 'agents/nested/.md', 'model: fixture/nested');
  const agents = await readNativeAgentFrontmatter(f.context);
  assert.equal(agents.get('.md')?.fields.model?.value, 'fixture/dot');
  assert.equal(agents.get('.md')?.fields.model?.source.path, dot);
  assert.equal(agents.get('nested/.md')?.fields.model?.value, 'fixture/nested');
  assert.equal(agents.get('nested/.md')?.fields.model?.source.path, nested);
  assert.equal(agents.has(''), false);
  assert.equal(agents.has('nested/'), false);
});

test('same-batch duplicate native identities fail across singular and plural aliases', async (t) => {
  const f = await fixture(t);
  const first = await f.markdown(f.global, 'agent/first.md', 'name: collision\nmodel: fixture/first');
  const second = await f.markdown(f.global, 'agents/second.md', 'name: collision\nmodel: fixture/second');
  await assert.rejects(readNativeAgentFrontmatter(f.context), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ambiguous.*collision/is);
    assert.ok(error.message.includes(first));
    assert.ok(error.message.includes(second));
    return true;
  });
});

test('no-frontmatter agents and absent builtin agents have no authored pins or stored bodies', async (t) => {
  const f = await fixture(t);
  const path = join(f.global, 'agents/body.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'Native prompt with model: fixture/body.');
  const agents = await readNativeAgentFrontmatter(f.context);
  assert.deepEqual(agents.get('body')?.fields, {});
  assert.equal(agents.has('build'), false);
  assert.equal(JSON.stringify([...agents]).includes('Native prompt'), false);
  assert.equal(await readFile(path, 'utf8'), 'Native prompt with model: fixture/body.');
});

test('source fingerprints cover exact read bytes including opaque bodies and follow aliases', async (t) => {
  const f = await fixture(t);
  const path = await f.markdown(f.global, 'agents/pinned.md', 'model: fixture/a');
  const first = (await readNativeAgentFrontmatter(f.context)).get('pinned')!;
  const bytes = await readFile(path);
  assert.deepEqual(first.fields.model?.source, {
    path,
    canonicalPath: path,
    fingerprint: createHash('sha256').update(bytes).digest('hex'),
  });
  await writeFile(path, Buffer.concat([bytes, Buffer.from('\nChanged opaque body.')]));
  const next = (await readNativeAgentFrontmatter(f.context)).get('pinned')!;
  assert.notEqual(next.fields.model?.source.fingerprint, first.fields.model.source.fingerprint);
  assert.equal(next.fields.model?.value, first.fields.model.value);
  assert.equal(JSON.stringify(next).includes('opaque body'), false);
});

test('invalid UTF-8 bytes in opaque native bodies preserve metadata and exact source fingerprints', async (t) => {
  const f = await fixture(t);
  const path = await f.markdown(f.global, 'agents/invalid-body.md', 'model: fixture/invalid-body');
  const bytes = Buffer.concat([await readFile(path), Buffer.from([0xff])]);
  await writeFile(path, bytes);
  const agent = (await readNativeAgentFrontmatter(f.context)).get('invalid-body')!;
  assert.equal(agent.fields.model?.value, 'fixture/invalid-body');
  assert.equal(agent.fields.model.source.fingerprint, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(JSON.stringify(agent).includes('Opaque native body'), false);
});

test('mode batches follow agent batches and only explicit mode values create final pins', async (t) => {
  const f = await fixture(t);
  const source = await f.markdown(f.global, 'agents/shared.md', 'mode: all\nmodel: fixture/agent');
  await f.markdown(f.global, 'mode/shared.md', 'temperature: 0');
  let fields = (await readNativeAgentFrontmatter(f.context)).get('shared')!.fields;
  assert.equal(fields.mode?.value, 'all');
  assert.equal(fields.mode.source.path, source);
  assert.equal(fields.temperature?.value, 0);
  const mode = await f.markdown(f.global, 'mode/shared.md', 'mode: subagent');
  fields = (await readNativeAgentFrontmatter(f.context)).get('shared')!.fields;
  assert.equal(fields.mode?.value, 'primary');
  assert.deepEqual(fields.mode.authored, { mode: 'subagent' });
  assert.equal(fields.mode.derived, 'primary-mode');
  assert.equal(fields.mode.source.path, mode);
});

test('native metadata parsing never populates gray-matter whole-file cache or returns header prompts', async (t) => {
  const f = await fixture(t);
  const path = await f.markdown(
    f.global,
    'agents/pinned.md',
    'model: fixture/a\nprompt: [ignored, native, override]',
    'Private opaque body.',
  );
  const contents = await readFile(path, 'utf8');
  const cache = Reflect.get(matter, 'cache') as Record<string, unknown>;
  assert.equal(Object.hasOwn(cache, contents), false);
  const agents = await readNativeAgentFrontmatter(f.context);
  assert.equal(Object.hasOwn(cache, contents), false);
  assert.equal(JSON.stringify([...agents]).includes('Private opaque body'), false);
  assert.equal(JSON.stringify([...agents]).includes('ignored'), false);
  assert.equal(agents.get('pinned')?.fields.model?.value, 'fixture/a');
});

test('opaque native prompt body size does not limit authored metadata discovery', async (t) => {
  const f = await fixture(t);
  const body = 'Native opaque prompt.\n'.repeat(60_000);
  const path = await f.markdown(f.global, 'agents/large.md', 'model: fixture/large', body);
  assert.ok(Buffer.byteLength(await readFile(path)) > 1024 * 1024);
  const agents = await readNativeAgentFrontmatter(f.context);
  assert.equal(agents.get('large')?.fields.model?.value, 'fixture/large');
  assert.equal(JSON.stringify([...agents]).includes('Native opaque prompt'), false);
});

test('unsupported cyclic and non-JSON option values fail with a source diagnostic', async (t) => {
  const f = await fixture(t);
  for (const metadata of ['options: &loop\n  self: *loop', 'options:\n  date: 2025-01-01', 'options:\n  value: .inf']) {
    const path = await f.markdown(f.global, 'agents/unsupported.md', metadata);
    await assert.rejects(readNativeAgentFrontmatter(f.context), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /cyclic or non-JSON.*options/);
      assert.ok(error.message.includes(path));
      return true;
    });
  }
});

test('native-invalid known field shapes cannot create authored authority even in legacy modes', async (t) => {
  const f = await fixture(t);
  for (const metadata of [
    'name: false',
    'model: 0',
    'temperature: .inf',
    'top_p: false',
    'mode: invalid',
    'disable: 0',
    'hidden: "false"',
    'description: {}',
    'color: invalid',
    'steps: 0',
    'maxSteps: 9007199254740992',
    'options: []',
    'tools:\n  bash: ask',
    'permission:\n  todowrite:\n    "*": allow',
    'permission:\n  bash: [allow]',
  ]) {
    const path = await f.markdown(f.global, 'modes/invalid.md', metadata);
    await assert.rejects(readNativeAgentFrontmatter(f.context), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid native/);
      assert.ok(error.message.includes(path));
      return true;
    });
  }
});

test('native accepts empty string names and preserves wildcard permission order and nested policies', async (t) => {
  const f = await fixture(t);
  await f.markdown(
    f.global,
    'agents/empty.md',
    'name: ""\npermission:\n  "*": deny\n  edit:\n    "*": deny\n    "src/**": allow\n  bash: ask',
  );
  const permission = (await readNativeAgentFrontmatter(f.context)).get('')!.fields.permission!;
  assert.deepEqual(Object.keys(permission.value as Record<string, unknown>), ['*', 'edit', 'bash']);
  assert.deepEqual(permission.value, { '*': 'deny', edit: { '*': 'deny', 'src/**': 'allow' }, bash: 'ask' });
});

test('missing optional roots are empty while unresolved root aliases surface their paths', async (t) => {
  const f = await fixture(t);
  assert.equal((await readNativeAgentFrontmatter(f.context)).size, 0);
  await symlink(join(f.root, 'absent'), f.custom, 'dir');
  await assert.rejects(readNativeAgentFrontmatter(f.context), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(f.custom));
    assert.match(error.message, /unresolved symbolic link/);
    return true;
  });
});

test('malformed sources and unreadable discovered files surface their native source paths', async (t) => {
  const f = await fixture(t);
  const path = await f.markdown(f.global, 'agents/broken.md', 'model: [unterminated');
  await assert.rejects(readNativeAgentFrontmatter(f.context), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(path));
    return true;
  });
  await rm(path);
  await symlink(join(f.root, 'absent.md'), path);
  await assert.rejects(readNativeAgentFrontmatter(f.context), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(path));
    return true;
  });
});
