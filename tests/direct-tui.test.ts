import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { TuiDialogConfirmProps, TuiDialogSelectProps, TuiPluginApi, TuiToast } from '@opencode-ai/plugin/tui';
import descriptor from '../src/config-composer/server.ts';
import { registerConfiguration } from '../src/config-composer/tui.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { loadConfigurationContext } from '../src/config-composer/storage.ts';
import { readSelectionAt, saveSelection } from '../src/config-composer/composition/selection-state.ts';

type Dialog = { title: string; message?: string } & Partial<TuiDialogSelectProps<string> & TuiDialogConfirmProps>;
async function fixture(
  t: TestContext,
  pin = '',
  common: Record<string, unknown> = { temperature: 0.2 },
  extraAgents: Record<string, Record<string, unknown>> = {},
) {
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
    groups: { workers: { agent: common } },
    profiles: {
      a: { groups: { workers: { agent: { model: 'p/a' } } } },
      b: { agent: { worker: { model: 'p/b' } } },
    },
  });
  await writeFile(source, text);
  if (pin !== '') {
    await mkdir(join(root, 'agents'));
    await writeFile(join(root, 'agents/worker.md'), `---\n${pin}\n---\nOPAQUE`);
  }
  await mkdir(join(root, 'commands'));
  await writeFile(join(root, 'commands/review.md'), '---\n---\nOPAQUE');
  const hook = (await descriptor.server({ directory: root, worktree: root } as PluginInput)).config!;
  const config = {
    plugin: [packageName],
    agent: {
      worker: { groups: ['workers'], mode: 'primary' as const, model: 'p/native' },
      helper: { groups: ['workers'], mode: 'subagent' as const },
      ...extraAgents,
    },
    command: { review: { template: 'OPAQUE', agent: 'worker' } },
  };
  await hook(config);
  let current: Dialog | undefined;
  let closed: (() => void) | undefined;
  const commands: { slashName: string; run: () => void }[] = [];
  let command = () => {};
  let disposed = 0;
  let configReads = 0;
  let afterConfigRead = () => Promise.resolve();
  let catalogWait = () => Promise.resolve();
  const rendered: string[] = [];
  let busy = false;
  const lifecycle = new AbortController();
  const toasts: TuiToast[] = [];
  const render = (props: Dialog) => {
    current = props;
    rendered.push(props.title);
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
        get: async () => {
          configReads++;
          await afterConfigRead();
          return { data: config };
        },
        providers: async () => {
          await catalogWait();
          return {
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
          };
        },
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
    rendered,
    get configReads() {
      return configReads;
    },
    onConfigRead: (operation: () => Promise<void>) => {
      afterConfigRead = operation;
    },
    holdCatalog: () => {
      const entered = Promise.withResolvers<undefined>();
      const pending = Promise.withResolvers<undefined>();
      catalogWait = () => {
        entered.resolve(undefined);
        return pending.promise;
      };
      return { entered: entered.promise, release: () => pending.resolve(undefined) };
    },
    startChoice: (title: string) => {
      const option = current?.options?.find((item) => item.title === title);
      assert.ok(option !== undefined);
      current?.onSelect?.(option);
    },
    context: () =>
      loadConfigurationContext({
        location: { root, directory: root },
        assertCurrent: () => {},
        config: async () => config,
        proveFilesystem: async () => {},
      }),
    reopenAfterPending: async () => {
      api.ui.dialog.clear();
      for (let i = 0; i < 1000; i++) {
        command();
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (current?.title === 'Profiles') {
          return;
        }
      }
      assert.fail('The pending profile action did not finish');
    },
    choose,
    escape,
    confirm,
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
test('only profiles and view-configs commands register; profiles open directly', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    f.commands.map((item) => item.slashName),
    ['profiles', 'view-configs'],
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
test('inspection opens untouched builtins and explains native inheritance', async (t) => {
  const f = await fixture(t);
  await f.open('view-configs', 'Configuration');
  await f.choose('agent build', 'agent build');
  assert.equal(f.current?.options?.find((option) => option.title === 'model')?.description, 'Inherit');
  await f.choose('model', 'agent build · model');
  assert.match(await f.detailText(), /No authored value at this level\. Native inheritance remains host-owned\./);
  assert.equal(f.disposed, 0);
});
test('prototype-like agent names inspect absent membership without treating inherited properties as groups', async (t) => {
  const f = await fixture(t, '', {}, Object.fromEntries(['constructor', 'toString'].map((name) => [name, {}])));
  for (const name of ['constructor', 'toString']) {
    await f.open('view-configs', 'Configuration');
    await f.choose(`agent ${name}`, `agent ${name}`);
    assert.equal(f.current?.options?.find((option) => option.title === 'groups')?.description, '[]');
    await f.choose('groups', `agent ${name} · groups`);
    assert.equal(await f.detailText(), 'No declared groups.');
  }
  assert.equal(f.toasts.length, 0);
  assert.equal(f.disposed, 0);
});
test('inspection exposes shared groups and inactive profiles without edit actions', async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  await f.open('view-configs', 'Configuration');
  await f.choose('Shared groups', 'Shared groups');
  await f.choose('workers', 'Shared group workers');
  assert.doesNotMatch(f.current?.message ?? '', /members/);
  assert.match(f.current?.message ?? '', /temperature/);
  await f.open('view-configs', 'Configuration');
  await f.choose('agent helper', 'agent helper');
  await f.choose('groups', 'agent helper · groups');
  assert.match(f.current?.message ?? '', /Application order: \["workers"\]/);
  assert.match(f.current?.message ?? '', /Native agent configuration/);
  await f.open('view-configs', 'Configuration');
  await f.choose('Profile definitions', 'Profile definitions');
  await f.choose('a', 'Profile a');
  assert.match(f.current?.message ?? '', /workers/);
  assert.equal(await f.read(), before);
  assert.equal(f.disposed, 0);
});
test('inspection keeps loaded raw pins after native file edits', async (t) => {
  const f = await fixture(t, 'model: p/native');
  await writeFile(join(f.root, 'agents/worker.md'), '---\nmodel: p/b\n---\nNEW BODY');
  await f.open('view-configs', 'Configuration');
  await f.choose('agent worker', 'agent worker');
  await f.choose('model', 'agent worker · model');
  const details = await f.detailText();
  assert.match(details, /Pinned by frontmatter/);
  assert.doesNotMatch(details, /p\/b|awaiting reload/);
  assert.match(details, /Verified applied instance: "p\/native"/);
  assert.match(details, /Configured\nmodel:/);
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
  const runtime = readRuntimeContext(f.config, { root: f.root, directory: f.root });
  const selection = await readSelectionAt(runtime.selectionEnvironment, runtime.selectionLocator);
  await saveSelection(selection, 'deleted', async () => {});
  await f.reopen();
  await f.choose('Shared only', 'Apply profile selection?');
  await f.confirm('Composer revision applied');
  assert.equal(readRuntimeContext(f.config, { root: f.root, directory: f.root }).selection?.choice, null);
});
test('inspection and profile switching retain loaded definitions after malformed source edits', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, '{"profiles":');
  await f.open('view-configs', 'Configuration');
  assert.notEqual(
    f.current?.options?.some((option) => /reload/i.test(option.title)),
    true,
  );
  await f.choose('Profile definitions', 'Profile definitions');
  await f.choose('a', 'Profile a');
  assert.match(f.current?.message ?? '', /workers/);
  await f.reopen();
  await f.choose('○ a', 'Apply profile selection?');
  await f.confirm('Composer revision applied');
  assert.equal(f.config.agent.worker.model, 'p/a');
  assert.equal(await f.read(), '{"profiles":');
});
test('inspection ignores source-only edits without pending notices', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, (await f.read()) + '\n');
  await f.open('view-configs', 'Configuration');
  await f.choose('Runtime status and sources', 'Runtime status and sources');
  assert.match(await f.detailText(), /Saved selection matches verified applied instance/);
  assert.equal(f.toasts.length, 0);
});
test('requested profile switch rejects native edits without disposal or proactive warnings', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'opencode/opencode.json'), '{}');
  await f.open('view-configs', 'Configuration');
  assert.equal(f.toasts.length, 0);
  await f.reopen();
  await f.choose('○ a', 'Config Composer');
  assert.match(f.current?.message ?? '', /Native global JSON.*Restart the OpenCode server process/);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.disposed, 0);
});
test('unconfirmed profile application remains saved pending', async (t) => {
  const f = await fixture(t);
  const original = f.api.client.instance.dispose.bind(f.api.client.instance);
  t.mock.method(f.api.client.instance, 'dispose', async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    const { readRuntimeContext, publishRuntime } =
      await import('../src/config-composer/composition/runtime-baseline.ts');
    const runtime = readRuntimeContext(f.config, { root: f.root, directory: f.root });
    publishRuntime(f.config, {}, { ...runtime, definitionId: 'replacement' });
    return result;
  });
  await f.choose('○ a', 'Apply profile selection?');
  await f.confirm('Saved; not applied');
  await f.choose('Reason', 'Saved; not applied');
  assert.match(await f.detailText(), /did not confirm/);
  assert.equal(f.disposed, 1);
});
for (const replacement of ['route', 'client', 'lifecycle'] as const) {
  test(`stale inspection cannot appear after ${replacement} replacement`, async (t) => {
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
    f.commands.find((command) => command.slashName === 'view-configs')!.run();
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
test('profile apply only reports applied after the new registration is attested', async (t) => {
  const f = await fixture(t);
  const original = f.api.client.instance.dispose.bind(f.api.client.instance);
  const gate = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  t.mock.method(f.api.client.instance, 'dispose', async (...args: Parameters<typeof original>) => {
    started.resolve(undefined);
    await gate.promise;
    return original(...args);
  });
  await f.choose('○ a', 'Apply profile selection?');
  const confirmed = f.confirm('Composer revision applied');
  await started.promise;
  assert.notEqual(f.current?.title, 'Composer revision applied');
  assert.equal(f.toasts.length, 0);
  gate.resolve(undefined);
  await confirmed;
  assert.equal(f.disposed, 1);
  assert.equal(f.toasts.length, 0);
});

test('profile catalog preview uses only the outer before/after runtime checks', async (t) => {
  const f = await fixture(t);
  const before = f.configReads;
  await f.choose('○ a', 'Apply profile selection?');
  assert.equal(f.configReads - before, 2);
  assert.equal(f.disposed, 0);
});

for (const mutation of ['selection', 'frontmatter', 'native-json', 'command-body'] as const) {
  test(`TUI preview rejects ${mutation} changes while the provider catalog is pending`, async (t) => {
    const f = await fixture(t, 'model: p/native');
    const context = await f.context();
    const gate = f.holdCatalog();
    f.startChoice('○ a');
    await gate.entered;
    if (mutation === 'selection') {
      await saveSelection(context.selection, null, async () => {});
    } else if (mutation === 'frontmatter') {
      await writeFile(join(f.root, 'agents/worker.md'), '---\nmodel: p/b\n---\nOPAQUE');
    } else if (mutation === 'native-json') {
      await writeFile(join(f.root, 'opencode.json'), '{}');
    } else {
      await writeFile(join(f.root, 'commands/review.md'), '---\n---\nCHANGED BODY');
    }
    gate.release();
    await f.wait('Config Composer');
    assert.match(f.current?.message ?? '', /changed|selection/i);
    assert.equal(f.rendered.includes('Apply profile selection?'), false);
    const selection = await readSelectionAt(context.runtime.selectionEnvironment, context.runtime.selectionLocator);
    assert.equal(selection.choice, mutation === 'selection' ? null : undefined);
    assert.equal(f.disposed, 0);
  });
}

for (const mutation of ['client', 'route', 'dismiss', 'abort'] as const) {
  test(`TUI preview cannot restore a confirmation after ${mutation} during the provider await`, async (t) => {
    const f = await fixture(t);
    const context = await f.context();
    const gate = f.holdCatalog();
    f.startChoice('○ a');
    await gate.entered;
    if (mutation === 'client') {
      Object.assign(f.api, { client: new Proxy(f.api.client, {}) });
    } else if (mutation === 'route') {
      Object.assign(f.api.route, { current: { name: 'home' } });
    } else if (mutation === 'abort') {
      f.lifecycle.abort();
    }
    f.api.ui.dialog.clear();
    gate.release();
    if (mutation === 'abort') {
      // Abort prevents future commands; wait for the in-flight provider action's
      // post-await connection assertion to finish by draining its I/O first.
      await f.context();
    } else {
      await f.reopenAfterPending();
    }
    assert.equal(f.rendered.includes('Apply profile selection?'), false);
    assert.equal(f.rendered.includes('Config Composer'), false);
    await assert.rejects(readFile(context.selection.path), /ENOENT/);
    assert.equal(f.disposed, 0);
  });
}

for (const mutation of ['frontmatter', 'native-json', 'command-body'] as const) {
  test(`TUI preview rechecks ${mutation} after the post-provider runtime read yields`, async (t) => {
    const f = await fixture(t);
    const context = await f.context();
    const gate = f.holdCatalog();
    f.startChoice('○ a');
    await gate.entered;
    f.onConfigRead(async () => {
      if (mutation === 'frontmatter') {
        await mkdir(join(f.root, 'agents'));
        await writeFile(join(f.root, 'agents/worker.md'), '---\nmodel: p/b\n---\nOPAQUE');
      } else if (mutation === 'native-json') {
        await writeFile(join(f.root, 'opencode.json'), '{}');
      } else {
        await writeFile(join(f.root, 'commands/review.md'), '---\n---\nCHANGED BODY');
      }
    });
    gate.release();
    await f.wait('Config Composer');
    assert.match(f.current?.message ?? '', /changed/i);
    assert.equal(f.rendered.includes('Apply profile selection?'), false);
    await assert.rejects(readFile(context.selection.path), /ENOENT/);
    assert.equal(f.disposed, 0);
  });
}

for (const boundary of ['provider', 'runtime'] as const) {
  test(`TUI preview uses loaded definitions when source changes during the ${boundary} await`, async (t) => {
    const f = await fixture(t);
    const context = await f.context();
    const gate = f.holdCatalog();
    f.startChoice('○ a');
    await gate.entered;
    const replaceSource = () => writeFile(f.source, '{ invalid replacement');
    if (boundary === 'provider') {
      await replaceSource();
    } else {
      f.onConfigRead(replaceSource);
    }
    gate.release();
    await f.wait('Apply profile selection?');
    assert.match(await f.preview(), /p\/a/);
    assert.deepEqual((await f.context()).source, context.source);
    await assert.rejects(readFile(context.selection.path), /ENOENT/);
    assert.equal(f.disposed, 0);
  });
}
