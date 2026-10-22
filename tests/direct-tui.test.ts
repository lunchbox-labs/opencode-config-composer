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
  TuiToast,
} from '@opencode-ai/plugin/tui';
import descriptor from '../src/config-composer/server.ts';
import { registerConfiguration } from '../src/config-composer/tui.ts';
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
  const commands: { slashName: string; run: () => void }[] = [];
  let command = () => {};
  let disposed = 0;
  let busy = false;
  const lifecycle = new AbortController();
  const toasts: TuiToast[] = [];
  const render = (props: Dialog) => {
    current = props;
  };
  const api = {
    state: { path: { directory: root, worktree: root } },
    route: { current: { name: 'session', params: { sessionID: 'one' } } },
    lifecycle: { signal: lifecycle.signal, onDispose: () => {} },
    keymap: {
      registerLayer: (layer: { commands: { slashName: string; run: () => void }[] }) => {
        commands.push(...layer.commands);
        command = (layer.commands.find((item) => item.slashName === 'profiles') ?? layer.commands[0]).run;
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
      toast: (toast: TuiToast) => toasts.push(toast),
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
  registerConfiguration(api);
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
  const detailText = async () => {
    const title = current!.title;
    let text = current?.message ?? '';
    const pages = current?.options?.filter((option) => option.title.startsWith('Page ')) ?? [];
    for (const page of pages) {
      await choose(page.title, `${title} · ${Number(page.value) + 1}/${pages.length}`);
      text += current?.message ?? '';
      await escape(title);
    }
    return text;
  };
  const preview = async () => {
    const title = current!.title;
    let text = current?.message ?? '';
    const pages = current?.options?.filter((option) => option.title.startsWith('Review page')) ?? [];
    for (const page of pages) {
      await choose(page.title, `Preview · ${Number(page.value) + 1}/${pages.length}`);
      text += current?.message ?? '';
      await escape(title);
    }
    return text;
  };
  command();
  await wait('Profiles');
  return {
    api,
    commands,
    toasts,
    lifecycle,
    open: async (name: string, title: string) => {
      api.ui.dialog.clear();
      commands.find((item) => item.slashName === name)!.run();
      await wait(title);
    },
    source,
    root,
    config,
    choose,
    escape,
    confirm,
    input,
    preview,
    detailText,
    wait,
    reopen: async () => {
      api.ui.dialog.clear();
      command();
      await wait('Profiles');
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
test('only profiles, view-configs and reload-configs commands register; profiles open directly', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    f.commands.map((item) => item.slashName),
    ['profiles', 'view-configs', 'reload-configs'],
  );
  assert.deepEqual(
    f.current?.options?.map((item) => item.title),
    ['Follow configured default', 'Shared only', '○ a', '○ b'],
  );
});
test('profile preview confirms selection and writes no definition bytes', async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  await f.choose('○ a', 'Apply profile selection?');
  assert.match(await f.preview(), /p\/a/);
  await f.escape('Profiles');
  assert.equal(f.disposed, 0);
  await f.choose('○ a', 'Apply profile selection?');
  await f.confirm('Composer revision applied');
  assert.equal(f.disposed, 1);
  assert.equal(f.config.agent.worker.model, 'p/a');
  assert.equal(await f.read(), before);
});
test('inspection exposes shared groups and inactive profiles without edit actions', async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  await f.open('view-configs', 'Configuration');
  await f.choose('Shared groups', 'Shared groups');
  await f.choose('workers', 'Shared group workers');
  assert.match(f.current?.message ?? '', /helper/);
  assert.match(f.current?.message ?? '', /temperature/);
  await f.open('view-configs', 'Configuration');
  await f.choose('Profile definitions', 'Profile definitions');
  await f.choose('a', 'Profile a');
  assert.match(f.current?.message ?? '', /workers/);
  assert.equal(await f.read(), before);
  assert.equal(f.disposed, 0);
});
test('stale native pins are shown as on-disk pending without predicting effective values', async (t) => {
  const f = await fixture(t, 'model: p/native');
  await writeFile(join(f.root, 'agents/worker.md'), '---\nmodel: p/b\n---\nNEW BODY');
  await f.open('view-configs', 'Configuration');
  await f.choose('agent worker', 'agent worker');
  await f.choose('model', 'agent worker · model');
  const details = await f.detailText();
  assert.match(details, /awaiting reload/);
  assert.match(details, /p\/b/);
  assert.match(details, /Verified applied instance: "p\/native"/);
  assert.doesNotMatch(f.current?.message ?? '', /Configured\nmodel:/);
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
    await f.open('view-configs', 'Configuration');
    await f.choose('agent worker', 'agent worker');
    await f.choose(field, `agent worker · ${field}`);
    const details = await f.detailText();
    assert.match(details, /Pinned by frontmatter/);
    assert.match(details, /worker\.md/);
    assert.match(details, /Raw authored fields:/);
    assert.match(details, /Blocked Composer value:/);
    if (field === 'permission') {
      assert.match(details, /inheritance remains host-owned/);
    }
    assert.equal(await f.read(), before);
    assert.equal(await readFile(join(f.root, 'agents/worker.md'), 'utf8'), native);
    assert.equal(f.disposed, 0);
  });
}
test('busy selection remains saved and pending without disposal', async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  f.setBusy();
  await f.choose('○ b', 'Apply profile selection?');
  await f.confirm('Saved; not applied');
  assert.equal(f.disposed, 0);
  assert.equal(await f.read(), before);
});
test('deleted saved profile can be recovered through Shared only', async (t) => {
  const f = await fixture(t);
  const { readRuntimeContext } = await import('../src/config-composer/composition/runtime-baseline.ts');
  const { readSelection, saveSelection } = await import('../src/config-composer/composition/selection-state.ts');
  const runtime = readRuntimeContext(f.config, { root: f.root, directory: f.root });
  const selection = await readSelection(runtime.selectionEnvironment, { root: f.root, baseFile: f.source });
  await saveSelection(selection, 'deleted', async () => {});
  await f.reopen();
  await f.choose('Shared only', 'Apply profile selection?');
  await f.confirm('Composer revision applied');
  assert.equal(readRuntimeContext(f.config, { root: f.root, directory: f.root }).selection?.choice, null);
});
test('malformed source reports its error and corrected external source reopens inspection', async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  await writeFile(f.source, '{"profiles":');
  await f.open('view-configs', 'Config Composer');
  assert.match(f.current?.message ?? '', /config-composer.jsonc|configuration|JSON/);
  assert.equal(f.disposed, 0);
  await writeFile(f.source, before);
  await f.open('view-configs', 'Configuration');
  assert.equal(f.disposed, 0);
});
test('inspection marks source-only changes pending even when effective values are equal', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, (await f.read()) + '\n');
  await f.open('view-configs', 'Configuration');
  await f.choose('Runtime status and sources', 'Runtime status and sources');
  assert.match(await f.detailText(), /Saved configuration pending/);
});
test('inspection reload menu applies external source without changing its bytes', async (t) => {
  const f = await fixture(t);
  const document = JSON.parse(await f.read()) as { agent?: object };
  document.agent = { helper: { top_p: 0.75 } };
  const text = JSON.stringify(document);
  await writeFile(f.source, text);
  await f.open('view-configs', 'Configuration');
  await f.choose('Reload configurations', 'Configuration reloaded');
  assert.equal(f.disposed, 1);
  assert.equal(await f.read(), text);
});
for (const entry of ['command', 'inspection'] as const) {
  test(`restart-required global JSON edit warns from ${entry} without disposal or success`, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.root, 'opencode/opencode.json'), '{}');
    if (entry === 'command') {
      await f.open('reload-configs', 'Config Composer');
    } else {
      await f.open('view-configs', 'Configuration');
      await f.choose('Reload configurations', 'Config Composer');
    }
    assert.deepEqual(f.toasts, [
      { variant: 'warning', title: 'Config Composer', message: 'Restart OpenCode to apply these changes.' },
    ]);
    assert.match(f.current?.message ?? '', /Native global JSON.*Restart the OpenCode server process/);
    assert.equal(f.disposed, 0);
    assert.notEqual(f.current?.title, 'Configuration reloaded');
  });
}
test('missing global cache baseline warns without disposal', async (t) => {
  const f = await fixture(t);
  const { readRuntimeContext, publishRuntime } = await import('../src/config-composer/composition/runtime-baseline.ts');
  const runtime = readRuntimeContext(f.config, { root: f.root, directory: f.root });
  delete runtime.globalJsonBaseline;
  publishRuntime(f.config, {}, runtime);
  await f.open('reload-configs', 'Config Composer');
  assert.equal(f.toasts[0]?.variant, 'warning');
  assert.match(f.toasts[0]?.message ?? '', /Restart OpenCode/);
  assert.match(f.current?.message ?? '', /baseline is unavailable/);
  assert.equal(f.disposed, 0);
});
for (const failure of ['busy', 'invalid', 'not-confirmed'] as const) {
  test(`${failure} reload keeps its detailed classification without a restart toast or success`, async (t) => {
    const f = await fixture(t);
    if (failure === 'busy') {
      f.setBusy();
    }
    if (failure === 'invalid') {
      await writeFile(f.source, '{"invalid":true}');
    }
    if (failure === 'not-confirmed') {
      const original = f.api.client.instance.dispose.bind(f.api.client.instance);
      t.mock.method(f.api.client.instance, 'dispose', async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        const { readRuntimeContext, publishRuntime } =
          await import('../src/config-composer/composition/runtime-baseline.ts');
        const runtime = readRuntimeContext(f.config, { root: f.root, directory: f.root });
        publishRuntime(
          f.config,
          {},
          { ...runtime, revision: { sources: runtime.revision!.sources, effective: '0'.repeat(64) } },
        );
        return result;
      });
    }
    await f.open('reload-configs', 'Config Composer');
    assert.equal(f.toasts.length, 0);
    assert.notEqual(f.current?.title, 'Configuration reloaded');
    assert.match(
      f.current?.message ?? '',
      failure === 'busy' ? /still running/ : failure === 'invalid' ? /Unknown key/ : /Reload is not confirmed/,
    );
    assert.equal(f.disposed, failure === 'not-confirmed' ? 1 : 0);
  });
}
for (const replacement of ['route', 'client', 'lifecycle'] as const) {
  test(`restart warning cannot appear after ${replacement} replacement`, async (t) => {
    const f = await fixture(t);
    const { readRuntimeContext, publishRuntime } =
      await import('../src/config-composer/composition/runtime-baseline.ts');
    const runtime = readRuntimeContext(f.config, { root: f.root, directory: f.root });
    delete runtime.globalJsonBaseline;
    publishRuntime(f.config, {}, runtime);
    const gate = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    const original = f.api.client.config.get.bind(f.api.client.config);
    t.mock.method(f.api.client.config, 'get', async (...args: Parameters<typeof original>) => {
      started.resolve(undefined);
      await gate.promise;
      return original(...args);
    });
    f.api.ui.dialog.clear();
    f.commands.find((command) => command.slashName === 'reload-configs')!.run();
    await started.promise;
    if (replacement === 'route') {
      Object.assign(f.api.route, { current: { name: 'home' } });
    }
    if (replacement === 'client') {
      Object.assign(f.api, { client: new Proxy(f.api.client, {}) });
    }
    if (replacement === 'lifecycle') {
      f.lifecycle.abort();
    }
    gate.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.toasts.length, 0);
    assert.equal(f.current, undefined);
    assert.equal(f.disposed, 0);
  });
}
test('successful explicit reload only reports applied after the new registration is attested', async (t) => {
  const f = await fixture(t);
  const original = f.api.client.instance.dispose.bind(f.api.client.instance);
  const gate = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  t.mock.method(f.api.client.instance, 'dispose', async (...args: Parameters<typeof original>) => {
    started.resolve(undefined);
    await gate.promise;
    return original(...args);
  });
  f.api.ui.dialog.clear();
  f.commands.find((command) => command.slashName === 'reload-configs')!.run();
  await started.promise;
  assert.equal(f.current, undefined);
  assert.equal(f.toasts.length, 0);
  gate.resolve(undefined);
  await f.wait('Configuration reloaded');
  assert.equal(f.disposed, 1);
  assert.equal(f.toasts.length, 0);
});
