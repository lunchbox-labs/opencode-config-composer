import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type {
  TuiDialogConfirmProps,
  TuiDialogPromptProps,
  TuiDialogSelectProps,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui';
import descriptor from '../src/config-composer/server.ts';
import { registerSettings } from '../src/config-composer/tui.ts';
import { packageName } from '../src/config-composer/package-name.ts';

type Dialog = { title: string; message?: string } & Partial<
  TuiDialogSelectProps<string> & TuiDialogPromptProps & TuiDialogConfirmProps
>;
async function fixture(t: TestContext, pin = '', common: Record<string, unknown> = { temperature: 0.2 }) {
  const root = await mkdtemp(join(tmpdir(), 'composer-direct-tui-'));
  const keys = ['OPENCODE_CONFIG_DIR', 'OPENCODE_TEST_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'];
  const before = keys.map((k) => process.env[k]);
  keys.forEach((k) => (process.env[k] = root));
  t.after(async () => {
    keys.forEach((k, i) => {
      if (before[i] === undefined) {
        Reflect.deleteProperty(process.env, k);
      } else {
        process.env[k] = before[i];
      }
    });
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'config-composer.jsonc');
  const text = JSON.stringify({
    groups: [{ name: 'workers', members: { agent: ['worker', 'helper'] }, agent: common }],
    profiles: {
      a: { groups: [{ name: 'workers', agent: { model: 'p/a' } }] },
      b: { agent: { worker: { model: 'p/b' } } },
    },
  });
  await writeFile(source, text);
  if (pin !== '') {
    await mkdir(join(root, 'agents'));
    await writeFile(join(root, 'agents/worker.md'), `---\n${pin}\n---\nOPAQUE`);
  }
  const hook = (await descriptor.server({ directory: root, worktree: root } as PluginInput)).config!;
  const config = {
    plugin: [packageName],
    agent: { worker: { mode: 'primary' as const, model: 'p/native' }, helper: { mode: 'subagent' as const } },
    command: { review: { template: 'OPAQUE', agent: 'worker' } },
  };
  await hook(config);
  let current: Dialog | undefined;
  let closed: (() => void) | undefined;
  let command = () => {};
  let disposed = 0;
  let busy = false;
  const lifecycle = new AbortController();
  const render = (props: Dialog) => {
    current = props;
  };
  const api = {
    state: { path: { directory: root, worktree: root } },
    route: { current: { name: 'session', params: { sessionID: 'one' } } },
    lifecycle: { signal: lifecycle.signal, onDispose: () => {} },
    keymap: {
      registerLayer: (layer: { commands: { run: () => void }[] }) => {
        command = layer.commands[0].run;
        return () => {};
      },
    },
    client: {
      config: {
        get: async () => ({ data: config }),
        providers: async () => ({
          data: {
            providers: [
              {
                id: 'p',
                models: Object.fromEntries(
                  ['native', 'a', 'b'].map((id) => [id, { name: id, variants: { high: {} } }]),
                ),
              },
            ],
          },
        }),
      },
      file: {
        read: async ({ path }: { path: string }) => ({
          data: { type: 'text', content: await readFile(join(root, path), 'utf8') },
        }),
      },
      session: {
        status: async () => ({ data: busy ? { one: { type: 'busy' } } : {} }),
        get: async () => ({ data: { model: { providerID: 'p', modelID: 'native' } } }),
      },
      instance: {
        dispose: async () => {
          disposed++;
          await hook(config);
          return { data: true };
        },
      },
      app: { agents: async () => ({ data: [] }) },
      command: { list: async () => ({ data: [] }) },
    },
    ui: {
      DialogSelect: render,
      DialogPrompt: render,
      DialogConfirm: render,
      DialogAlert: render,
      dialog: {
        setSize: () => {},
        get open() {
          return current !== undefined;
        },
        replace: (next: () => void, onClose?: () => void) => {
          closed?.();
          closed = onClose;
          next();
        },
        clear: () => {
          closed?.();
          closed = undefined;
          current = undefined;
        },
      },
    },
  } as unknown as TuiPluginApi;
  registerSettings(api);
  const wait = async (title: string) => {
    for (let i = 0; i < 1000; i++) {
      if (current?.title === title) {
        await new Promise((resolve) => setImmediate(resolve));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.fail(`Expected ${title}; got ${JSON.stringify(current)}`);
  };
  const choose = async (title: string, next: string) => {
    const option = current?.options?.find((o) => o.title === title);
    assert.ok(option !== undefined, `${title} in ${JSON.stringify(current)}`);
    current?.onSelect?.(option);
    await wait(next);
  };
  const escape = async (next: string) => {
    api.ui.dialog.clear();
    await wait(next);
  };
  const confirm = async (next: string) => {
    if (current?.options?.some((option) => option.value === 'apply') === true) {
      await choose('Apply', 'Apply reviewed changes?');
    }
    (current as TuiDialogConfirmProps).onConfirm?.();
    api.ui.dialog.clear();
    await wait(next);
  };
  const input = async (value: string, next: string) => {
    (current as TuiDialogPromptProps).onConfirm?.(value);
    api.ui.dialog.clear();
    await wait(next);
  };
  command();
  await wait('Compose configs');
  return {
    api,
    source,
    root,
    config,
    choose,
    escape,
    confirm,
    input,
    wait,
    reopen: async () => {
      api.ui.dialog.clear();
      command();
      await wait('Compose configs');
    },
    get current() {
      return current;
    },
    get disposed() {
      return disposed;
    },
    setBusy: () => {
      busy = true;
    },
    read: () => readFile(source, 'utf8'),
  };
}
test('profile choose has one preview and Apply confirmation, cancellation writes nothing', async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  await f.choose('Profile', 'Profile');
  await f.choose('○ a', 'Apply profile selection?');
  assert.match(f.current?.message ?? '', /p\/a/);
  await f.escape('Profile');
  assert.equal(f.disposed, 0);
  assert.equal(await f.read(), before);
  await f.choose('○ a', 'Apply profile selection?');
  await f.confirm('Composer revision applied');
  assert.equal(f.disposed, 1);
  assert.equal(f.config.agent.worker.model, 'p/a');
  assert.equal(await f.read(), before);
});
test('group member toggles stage only and Back returns to direct shared settings', async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  await f.choose('Groups', 'Groups · shared');
  await f.choose('workers', 'Shared · workers');
  await f.choose('Members', 'Members · workers');
  await f.choose('✓ agent helper', 'Members · workers');
  assert.equal(await f.read(), before);
  await f.escape('Shared · workers');
  await f.choose('Agent settings for members', 'Shared · workers · agent settings');
  await f.choose('temperature', 'Shared · workers · temperature');
  await f.escape('Shared · workers · agent settings');
  assert.equal(await f.read(), before);
});
test('shared versus profile direct settings write explicit destinations and preserve zero', async (t) => {
  const f = await fixture(t);
  await f.choose('Groups', 'Groups · shared');
  await f.choose('workers', 'Shared · workers');
  await f.choose('Agent settings for members', 'Shared · workers · agent settings');
  await f.choose('temperature', 'Shared · workers · temperature');
  await f.choose('Edit value', 'Shared · workers · temperature');
  await f.input('0', 'Apply document changes?');
  await f.confirm('Composer revision applied');
  const parsed = JSON.parse(await f.read()) as {
    groups: { agent: { temperature: number } }[];
    profiles: { a: { groups: { agent: { temperature?: number } }[] } };
  };
  assert.equal(parsed.groups[0].agent.temperature, 0);
  assert.equal(parsed.profiles.a.groups[0].agent.temperature, undefined);
});
for (const pin of [
  'model: p/native',
  'temperature: 0',
  'variant: ""',
  'options: {}',
  'permission: deny',
  'permission: {}',
]) {
  test(`effective raw pin is read-only: ${pin}`, async (t) => {
    const field = pin.split(':')[0];
    const proposals: Record<string, unknown> = {
      model: 'p/b',
      temperature: 1,
      variant: 'high',
      options: { composer: true },
      permission: { edit: 'ask' },
    };
    const f = await fixture(t, pin, { [field]: proposals[field] });
    const before = await f.read();
    const native = await readFile(join(f.root, 'agents/worker.md'), 'utf8');
    await f.choose('Effective', 'Effective configuration');
    await f.choose('agent worker', 'agent worker');
    await f.choose(field, `agent worker · ${field}`);
    assert.match(f.current?.message ?? '', /Pinned by frontmatter/);
    assert.match(f.current?.message ?? '', /worker\.md/);
    assert.match(f.current?.message ?? '', /Raw authored fields:/);
    assert.match(f.current?.message ?? '', /Blocked Composer value:/);
    if (field === 'permission') {
      assert.match(f.current?.message ?? '', /inheritance remains host-owned/);
    }
    assert.equal(await f.read(), before);
    assert.equal(await readFile(join(f.root, 'agents/worker.md'), 'utf8'), native);
    assert.equal(f.disposed, 0);
  });
}
test('busy application reports saved; not applied without disposal', async (t) => {
  const f = await fixture(t);
  f.setBusy();
  await f.choose('Profile', 'Profile');
  await f.choose('○ b', 'Apply profile selection?');
  await f.confirm('Saved; not applied');
  assert.equal(f.disposed, 0);
});

test('a catalog result cannot reopen a picker after Escape', async (t) => {
  const f = await fixture(t);
  await f.choose('Profile', 'Profile');
  const gate = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const original = f.api.client.config.providers.bind(f.api.client.config);
  t.mock.method(f.api.client.config, 'providers', async (...args: Parameters<typeof original>) => {
    started.resolve(undefined);
    await gate.promise;
    return original(...args);
  });
  const option = f.current!.options!.find((option) => option.value === 'choose:a')!;
  f.current!.onSelect!(option);
  await started.promise;
  await f.escape('Compose configs');
  gate.resolve(undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.current?.title, 'Compose configs');
  assert.equal(f.disposed, 0);
});
test('pending apply retry never adopts an external source edit', async (t) => {
  const f = await fixture(t);
  f.setBusy();
  await f.choose('Profile', 'Profile');
  await f.choose('○ b', 'Apply profile selection?');
  await f.confirm('Saved; not applied');
  const document = JSON.parse(await f.read()) as { profiles: Record<string, unknown> };
  document.profiles.b = { agent: { worker: { model: 'p/a' } } };
  await writeFile(f.source, JSON.stringify(document));
  await f.choose('Retry apply', 'Config Composer');
  assert.match(f.current?.message ?? '', /changed.*review again/i);
  assert.equal(f.disposed, 0);
});
test('a profile edit remains in that profile even while no profile is selected', async (t) => {
  const f = await fixture(t);
  await f.choose('Profile', 'Profile');
  await f.choose('Edit a', 'Profile a');
  await f.choose('Group settings', 'Profile a · groups');
  await f.choose('workers', 'Profile a · workers');
  await f.choose('Agent settings for members', 'Profile a · workers · agent settings');
  await f.choose('temperature', 'Profile a · workers · temperature');
  await f.choose('Edit value', 'Profile a · workers · temperature');
  await f.input('0', 'Apply document changes?');
  await f.confirm('Composer revision applied');
  const document = JSON.parse(await f.read()) as {
    groups: { agent: { temperature: number } }[];
    profiles: { a: { groups: { agent: { temperature: number } }[] } };
  };
  assert.equal(document.groups[0].agent.temperature, 0.2);
  assert.equal(document.profiles.a.groups[0].agent.temperature, 0);
});

test('adding an exact tool block preserves an existing scalar permission policy', async (t) => {
  const f = await fixture(t, '', { permission: 'deny' });
  await f.choose('Groups', 'Groups · shared');
  await f.choose('workers', 'Shared · workers');
  await f.choose('Agent settings for members', 'Shared · workers · agent settings');
  await f.choose('permission', 'Shared · workers · permission');
  await f.choose('Edit value', 'Shared · workers · permission');
  await f.choose('Add tool block', 'Native permission tool key');
  await f.input('bash', 'Shared · workers · permission · bash');
  await f.choose('Edit tool block', 'Shared · workers · permission · bash');
  await f.input('{"git *":"allow"}', 'Apply document changes?');
  await f.confirm('Composer revision applied');
  const document = JSON.parse(await f.read()) as { groups: { agent: { permission: unknown } }[] };
  assert.deepEqual(document.groups[0].agent.permission, { '*': 'deny', bash: { 'git *': 'allow' } });
});
test('invalid saved-name rescue offers default and none without needing current resolution', async (t) => {
  const f = await fixture(t);
  const { readRuntimeContext } = await import('../src/config-composer/composition/runtime-baseline.ts');
  const { readSelection, saveSelection } = await import('../src/config-composer/composition/selection-state.ts');
  const runtime = readRuntimeContext(f.config, { root: f.root, directory: f.root });
  const selection = await readSelection(runtime.selectionEnvironment, { root: f.root, baseFile: f.source });
  await saveSelection(selection, 'deleted', async () => {});
  await f.reopen();
  await f.choose('Profile', 'Profile');
  assert.equal(
    f.current?.options?.some((option) => option.title === 'Use configured default'),
    true,
  );
  await f.choose('No profile — keep shared settings', 'Apply profile selection?');
  await f.confirm('Composer revision applied');
  assert.equal(readRuntimeContext(f.config, { root: f.root, directory: f.root }).selection?.choice, null);
});
test('native metadata changes require restart and review without a refresh action', async (t) => {
  const f = await fixture(t, 'model: p/native');
  await writeFile(join(f.root, 'agents/worker.md'), '---\nmodel: p/a\n---\nOPAQUE');
  await f.choose('Profile', 'Profile');
  await f.choose('○ b', 'Config Composer');
  assert.match(f.current?.message ?? '', /Restart OpenCode, then review again/);
  assert.equal(f.disposed, 0);
  assert.equal(f.current?.options, undefined);
});

test('group creation stages an empty membership and cannot persist until a member is chosen', async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  await f.choose('Groups', 'Groups · shared');
  await f.choose('Create group', 'New group name');
  await f.input('new-team', 'Members · new-team');
  assert.equal(await f.read(), before);
  await f.choose('Review changes', 'Config Composer');
  assert.match(f.current?.message ?? '', /At least one/);
  assert.equal(await f.read(), before);
  await f.escape('Members · new-team');
  await f.choose('○ agent worker', 'Members · new-team');
  await f.choose('Review changes', 'Apply document changes?');
  await f.confirm('Composer revision applied');
  const document = JSON.parse(await f.read()) as { groups: { name: string; members: object }[] };
  assert.deepEqual(document.groups.at(-1), { name: 'new-team', members: { agent: ['worker'], command: [] } });
});
test('native JSON editing rejects duplicate tool keys before review or writing', async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  await f.choose('Groups', 'Groups · shared');
  await f.choose('workers', 'Shared · workers');
  await f.choose('Agent settings for members', 'Shared · workers · agent settings');
  await f.choose('permission', 'Shared · workers · permission');
  await f.choose('Edit value', 'Shared · workers · permission');
  await f.choose('Edit complete permission', 'Shared · workers · permission JSON');
  await f.input('{"edit":"deny","edit":"allow"}', 'Config Composer');
  assert.match(f.current?.message ?? '', /duplicate JSON keys/);
  assert.equal(await f.read(), before);
});

test('saved apply cannot display recovery on a replacement route', async (t) => {
  const f = await fixture(t);
  const moved = Promise.withResolvers<undefined>();
  t.mock.method(f.api.client.session, 'status', async () => {
    Object.assign(f.api.route, { current: { name: 'home' } });
    f.api.ui.dialog.clear();
    moved.resolve(undefined);
    return { data: {} };
  });
  await f.choose('Profile', 'Profile');
  await f.choose('○ a', 'Apply profile selection?');
  (f.current as TuiDialogConfirmProps).onConfirm!();
  f.api.ui.dialog.clear();
  await moved.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.current, undefined);
  assert.equal(f.disposed, 0);
});

test('root has three areas and saved apply recovery stays in Effective', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    f.current?.options?.map((option) => option.title),
    ['Profile', 'Groups', 'Effective'],
  );
  await f.choose('Effective', 'Effective configuration');
  assert.ok(f.current.options.some((option) => option.title === 'Apply saved changes'));
});

test('profile preview separates pinned members from effective changes', async (t) => {
  const f = await fixture(t, 'model: p/native');
  await f.choose('Profile', 'Profile');
  await f.choose('○ b', 'Apply profile selection?');
  let text = f.current?.message ?? '';
  const pages = f.current?.options?.filter((option) => option.title.startsWith('Review page')) ?? [];
  for (const page of pages) {
    await f.choose(page.title, `Preview · ${Number(page.value) + 1}/${pages.length}`);
    text += f.current?.message ?? '';
    await f.escape('Apply profile selection?');
  }
  assert.match(text, /Pinned members retain frontmatter/);
  assert.match(text, /Blocked Composer value/);
  assert.equal(f.disposed, 0);
});
