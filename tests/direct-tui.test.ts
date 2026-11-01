import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { TuiDialogConfirmProps, TuiDialogSelectProps, TuiPluginApi, TuiToast } from '@opencode-ai/plugin/tui';
import descriptor from '../src/config-composer/server.ts';
import { registerConfiguration } from '../src/config-composer/tui.ts';
import { appliedProfile } from '../src/config-composer/tui/inspection.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import { loadConfigurationContext } from '../src/config-composer/storage.ts';
import { readSelectionAt, saveSelection } from '../src/config-composer/composition/selection-state.ts';

type Dialog = { title: string; message?: string } & Partial<TuiDialogSelectProps<string> & TuiDialogConfirmProps>;
async function fixture(
  t: TestContext,
  pin = '',
  common: Record<string, unknown> = { temperature: 0.2 },
  extraAgents: Record<string, Record<string, unknown>> = {},
  sourceDocument?: Record<string, unknown>,
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
  const text = JSON.stringify(
    sourceDocument ?? {
      groups: { workers: { agent: common } },
      profiles: {
        a: { groups: { workers: { agent: { model: 'p/a' } } } },
        b: { agent: { worker: { model: 'p/b' } } },
      },
    },
  );
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
  let nativeAgents: Record<string, unknown>[] = [];
  let current: Dialog | undefined;
  let closed: (() => void) | undefined;
  const commands: { slashName: string; run: () => void }[] = [];
  let command = () => {};
  let disposed = 0;
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
    state: { config, path: { directory: root, worktree: root } },
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
      app: {
        agents: async () => ({
          data: [
            ...['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary'].map((name) => ({
              name,
              native: true,
            })),
            ...nativeAgents,
          ],
        }),
      },
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
  registerConfiguration(api, api.ui.DialogSelect);
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
    setNativeAgents: (agents: Record<string, unknown>[]) => {
      nativeAgents = agents;
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

test('profile confirmation includes changed and removed model parameter defaults', async (t) => {
  const f = await fixture(
    t,
    'temperature: 0\noptions: {}',
    {},
    {},
    {
      models: { coding: { model: 'p/a', maxOutputTokens: 10 } },
      groups: { workers: { agent: { modelRef: 'coding' } } },
      profiles: {
        a: {
          models: {
            coding: { model: 'p/a', temperature: 0.9, maxOutputTokens: 100, options: { reasoningEffort: 'low' } },
          },
        },
        b: { models: { coding: { model: 'p/a' } } },
      },
    },
  );
  await f.choose('○ a', 'Apply profile selection?');
  const changed = await f.preview();
  assert.match(changed, /Model-bound parameter changes/);
  assert.match(changed, /"maxOutputTokens": 100/);
  assert.match(changed, /temperature: 0 takes priority \(frontmatter\)/);
  assert.match(changed, /Alias options blocked by authored frontmatter/);
  await f.confirm('Composer revision applied');
  await f.reopen();
  await f.choose('○ b', 'Apply profile selection?');
  assert.match(await f.preview(), /Removed model-bound defaults/);
});
test('inspection attributes group and profile steps to their Composer pointers', async (t) => {
  const f = await fixture(
    t,
    '',
    {},
    { solo: { mode: 'subagent' } },
    {
      groups: { workers: { agent: { steps: 6 } } },
      profiles: { capped: { groups: { workers: { agent: { steps: 1 } } } } },
    },
  );
  // Native /agent reports an unset steps limit as null.
  f.setNativeAgents([
    { name: 'worker', native: false, steps: 6 },
    { name: 'solo', native: false, steps: null },
  ]);
  await f.open('view-configs', 'Configuration');
  await f.choose('agent solo', 'agent solo');
  assert.equal(f.current?.options?.find((option) => option.title === 'steps')?.description, 'Inherit');
  await f.choose('steps', 'agent solo · steps');
  assert.match(await f.detailText(), /Effective native steps: Inherit/);
  await f.open('view-configs', 'Configuration');
  await f.choose('agent worker', 'agent worker');
  assert.equal(f.current.options.find((option) => option.title === 'steps')?.description, '6');
  await f.choose('steps', 'agent worker · steps');
  // Long source pointers wrap in the dialog.
  const shared = (await f.detailText()).replaceAll('\n', '');
  assert.match(shared, /Loaded configuration contribution: 6/);
  assert.match(shared, /config-composer\.jsonc · \/groups\/workers\/agent\/steps/);
  assert.match(shared, /Effective native steps: 6/);
  await f.reopen();
  await f.choose('○ capped', 'Apply profile selection?');
  assert.match((await f.preview()).replaceAll('\n', ''), /\/profiles\/capped\/groups\/workers\/agent\/steps/);
  await f.confirm('Composer revision applied');
  f.setNativeAgents([{ name: 'worker', native: false, steps: 1 }]);
  await f.open('view-configs', 'Configuration');
  await f.choose('agent worker', 'agent worker');
  await f.choose('steps', 'agent worker · steps');
  const capped = (await f.detailText()).replaceAll('\n', '');
  assert.match(capped, /Loaded configuration contribution: 1/);
  assert.match(capped, /\/profiles\/capped\/groups\/workers\/agent\/steps/);
  assert.match(capped, /Effective native steps: 1/);
});
test('inspection opens untouched builtins and explains native inheritance', async (t) => {
  const f = await fixture(t);
  await f.open('view-configs', 'Configuration');
  assert.equal(
    f.current!.options!.some((option) => option.title === 'agent build'),
    false,
  );
  await f.choose('Show built-in agents', 'Configuration');
  await f.choose('agent build', 'agent build');
  assert.equal(f.current!.options!.find((option) => option.title === 'model')?.description, 'Inherit');
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
  assert.match(f.current?.message ?? '', /Loaded application order: \["workers"\]/);
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
  assert.match(details, /Loaded configuration contribution: "p\/native"/);
  assert.match(details, /model:/);
});
for (const pin of [
  'model: p/native',
  'temperature: 0',
  'steps: 2',
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
      steps: 9,
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
    if (pin === 'permission: {}') {
      assert.match(details, /frontmatter permission has no rules/);
      assert.match(details, /"edit":"ask"/);
    } else if (field === 'permission') {
      assert.match(details, /Frontmatter permission rules applied last/);
      assert.match(details, /Composer contribution before frontmatter:/);
    } else {
      assert.match(details, /Pinned by frontmatter/);
      assert.match(details, /Blocked Composer value:/);
    }
    assert.match(details, /worker\.md/);
    assert.match(details, /Raw authored fields:/);
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
  assert.match(await f.detailText(), /Current loaded server configuration/);
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

test('inspection tolerates later native contributions and never attributes them to frontmatter', async (t) => {
  const f = await fixture(t, 'model: p/native');
  f.config.agent.worker.model = 'p/b';
  await f.open('view-configs', 'Configuration');
  await f.choose('agent worker', 'agent worker');
  await f.choose('model', 'agent worker · model');
  const detail = await f.detailText();
  assert.match(detail, /p\/b/);
  assert.match(detail, /Loaded value differs from Composer’s recorded contribution/);
  assert.doesNotMatch(detail, /Pinned by frontmatter/);
  await f.open('profiles', 'Config Composer');
  assert.match(f.current?.message ?? '', /Configuration changed after Composer/);
});
test('read-only inspection needs neither a runtime marker nor shared filesystem access', async (t) => {
  const f = await fixture(t);
  f.config.plugin = [];
  f.api.client.file.read = async () => {
    throw new Error('must not read files');
  };
  await rm(join(f.root, 'opencode'), { recursive: true, force: true });
  await f.open('view-configs', 'Configuration');
  await f.choose('agent worker', 'agent worker');
  await f.choose('model', 'agent worker · model');
  assert.match(await f.detailText(), /p\/native/);
  assert.doesNotMatch(await f.detailText(), /Pinned by frontmatter/);
});
test('hidden custom agents stay inspectable while built-in agents start hidden', async (t) => {
  const f = await fixture(t, '', {}, { private: { hidden: true }, build: { model: 'p/b' } });
  await f.open('view-configs', 'Configuration');
  assert.equal(
    f.current?.options?.some((option) => option.title === 'agent private'),
    true,
  );
  assert.equal(
    f.current.options.some((option) => option.title === 'agent build'),
    false,
  );
  await f.choose('Show built-in agents', 'Configuration');
  assert.equal(
    f.current.options.some((option) => option.title === 'agent build'),
    true,
  );
  await f.choose('Hide built-in agents', 'Configuration');
  assert.equal(
    f.current.options.some((option) => option.title === 'agent build'),
    false,
  );
});

test('native resolved permissions are distinct from contributions and reordered rules lose attribution', async (t) => {
  const f = await fixture(t, '', { permission: { bash: { '*': 'ask', 'git *': 'allow' } } });
  f.setNativeAgents([
    {
      name: 'worker',
      native: false,
      permission: [
        { permission: '*', pattern: '*', action: 'allow' },
        { permission: 'bash', pattern: '*', action: 'ask' },
      ],
    },
  ]);
  await f.open('view-configs', 'Configuration');
  await f.choose('agent worker', 'agent worker');
  await f.choose('permission', 'agent worker · permission');
  const initial = await f.detailText();
  assert.match(initial, /Loaded configuration contribution/);
  assert.match(initial, /Effective native permission rules \(\/agent\), in evaluation order/);
  assert.match(initial, /"permission": "\*"/);
  assert.match(initial, /config-composer\.jsonc/);
  Reflect.set(f.config.agent.worker, 'permission', { bash: { 'git *': 'allow', '*': 'ask' } });
  await f.open('view-configs', 'Configuration');
  await f.choose('agent worker', 'agent worker');
  await f.choose('permission', 'agent worker · permission');
  const changed = await f.detailText();
  assert.match(changed, /Loaded value differs from Composer’s recorded contribution/);
  assert.doesNotMatch(changed, /config-composer\.jsonc/);
});
test('saved pending profile never replaces the applied profile label', async (t) => {
  const f = await fixture(t);
  assert.equal(appliedProfile(f.config, f.root, f.root), 'Shared only');
  f.setBusy();
  await f.choose('○ b', 'Apply profile selection?');
  await f.confirm('Saved; not applied');
  assert.equal(appliedProfile(f.config, f.root, f.root), 'Shared only');
  await f.open('view-configs', 'Configuration');
  await f.choose('Runtime status and sources', 'Runtime status and sources');
  assert.match(await f.detailText(), /Applied profile: Shared only/);
  assert.doesNotMatch(await f.detailText(), /Applied profile: b/);
});
for (const missing of ['applied', 'candidate', 'decisions'] as const) {
  test(`malformed ${missing} attribution leaves actual native settings inspectable`, async (t) => {
    const f = await fixture(t);
    const { readLoadedRuntime } = await import('../src/config-composer/composition/runtime-baseline.ts');
    const runtime = readLoadedRuntime(f.config, { directory: f.root, root: f.root });
    if (missing === 'decisions') {
      Reflect.deleteProperty(runtime.candidate!, missing);
    } else {
      Reflect.deleteProperty(runtime, missing);
    }
    Reflect.set(f.config, 'plugin', [[packageName, { __configComposerRuntime: runtime }]]);
    await f.open('view-configs', 'Configuration');
    await f.choose('agent worker', 'agent worker');
    await f.choose('groups', 'agent worker · groups');
    assert.match(await f.detailText(), /Loaded membership attribution unavailable/);
    await f.escape('agent worker');
    await f.choose('model', 'agent worker · model');
    assert.match(await f.detailText(), /Loaded configuration contribution: "p\/native"/);
    assert.match(await f.detailText(), /Composer source attribution unavailable/);
  });
}
test('config-only disabled agents are inspectable without suggesting an active inherited value', async (t) => {
  const f = await fixture(t, '', {}, { disabled: { disable: true, model: 'p/a' } });
  await f.open('view-configs', 'Configuration');
  await f.choose('agent disabled', 'agent disabled');
  await f.choose('model', 'agent disabled · model');
  assert.match(await f.detailText(), /Agent unavailable in the native roster/);
  assert.doesNotMatch(await f.detailText(), /Effective native model: Inherit/);
});
test('an effective native model different from the config contribution is explicitly distinguished', async (t) => {
  const f = await fixture(t, 'model: p/native');
  f.setNativeAgents([{ name: 'worker', native: false, model: { providerID: 'p', modelID: 'b' } }]);
  f.api.client.file.read = async () => {
    throw new Error('Inspection must not prove local filesystem access');
  };
  await f.open('view-configs', 'Configuration');
  await f.choose('agent worker', 'agent worker');
  await f.choose('model', 'agent worker · model');
  const detail = await f.detailText();
  assert.match(detail, /Loaded configuration contribution: "p\/native"/);
  assert.match(detail, /Effective native model: "p\/b"/);
  assert.match(detail, /Source attribution above covers only the config contribution/);
});
test('field menu descriptions redact credentials while keeping useful options visible', async (t) => {
  const f = await fixture(t, '', { options: { reasoningEffort: 'high', apiKey: 'PRIVATE_SENTINEL' } });
  await f.open('view-configs', 'Configuration');
  await f.choose('agent worker', 'agent worker');
  const description = f.current?.options?.find((option) => option.title === 'options')?.description ?? '';
  assert.doesNotMatch(description, /PRIVATE_SENTINEL/);
  assert.match(description, /reasoningEffort/);
  assert.match(description, /high/);
});
