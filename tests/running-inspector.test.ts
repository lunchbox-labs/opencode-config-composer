import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TuiDialogAlertProps, TuiDialogSelectProps, TuiPluginApi } from '@opencode-ai/plugin/tui';
import type { Config as PluginConfig } from '@opencode-ai/plugin';
import type { Config as NativeConfig } from '@opencode-ai/sdk/v2';
import { dialogNavigation } from '../src/tui/navigation.ts';
import { publishRuntimeBaseline } from '../src/config-composer/composition/runtime-baseline.ts';
import { packageName } from '../src/config-composer/package-name.ts';

type Config = PluginConfig & Pick<NativeConfig, 'default_agent'>;

async function subject() {
  const module = await import('../src/config-composer/tui/running.ts').catch(() => undefined);
  assert.ok(module !== undefined, 'the read-only running inspector is implemented');
  return module;
}

function fixture() {
  let config: Config = {
    model: 'fixture/running',
    small_model: 'fixture/small',
    default_agent: 'worker',
    agent: { worker: { model: 'fixture/running', variant: 'high' } },
    provider: { fixture: { options: { apiKey: 'provider-credential' } } },
  };
  let agents: unknown = [
    {
      name: 'worker',
      model: { providerID: 'fixture', modelID: 'running' },
      variant: 'high',
      temperature: 0.4,
      topP: 0.7,
      options: {},
    },
  ];
  let session: unknown = {
    id: 'conversation',
    agent: 'worker',
    model: { providerID: 'fixture', id: 'recorded', variant: 'low' },
  };
  let messages: unknown = [];
  let beforeAgents = () => {};
  let sessionFails = false;
  let historyFails = false;
  let dialog: TuiDialogSelectProps<string> | TuiDialogAlertProps | undefined;
  const reads: string[] = [];
  const directories: string[] = [];
  const api = {
    lifecycle: { signal: new AbortController().signal },
    route: { current: { name: 'session', params: { sessionID: 'conversation' } } },
    state: { path: { worktree: '/project', directory: '/project/subdir' } },
    client: {
      config: {
        get: async ({ directory }: { directory: string }) => {
          reads.push('config.get');
          directories.push(directory);
          return { data: structuredClone(config) };
        },
      },
      app: {
        agents: async ({ directory }: { directory: string }) => {
          reads.push('app.agents');
          directories.push(directory);
          beforeAgents();
          return { data: structuredClone(agents) };
        },
      },
      session: {
        get: async ({ directory }: { directory: string }) => {
          reads.push('session.get');
          directories.push(directory);
          return sessionFails ? { error: { message: 'secret-error' } } : { data: structuredClone(session) };
        },
        messages: async ({ directory }: { directory: string }) => {
          reads.push('session.messages');
          directories.push(directory);
          return historyFails ? { error: { message: 'secret-error' } } : { data: structuredClone(messages) };
        },
      },
    },
    ui: {
      DialogSelect: (props: TuiDialogSelectProps<string>) => {
        dialog = props;
      },
      DialogAlert: (props: TuiDialogAlertProps) => {
        dialog = props;
      },
      dialog: {
        replace: (render: () => void) => render(),
        clear: () => {
          dialog = undefined;
        },
      },
    },
  } as unknown as TuiPluginApi;
  return {
    api,
    reads,
    directories,
    get config() {
      return config;
    },
    set config(value: Config) {
      config = value;
    },
    set agents(value: unknown) {
      agents = value;
    },
    set session(value: unknown) {
      session = value;
    },
    set messages(value: unknown) {
      messages = value;
    },
    set beforeAgents(value: () => void) {
      beforeAgents = value;
    },
    set sessionFails(value: boolean) {
      sessionFails = value;
    },
    set historyFails(value: boolean) {
      historyFails = value;
    },
    get dialog() {
      return dialog;
    },
    select(value: string) {
      const menu = dialog as TuiDialogSelectProps<string>;
      const option = menu.options.find((item) => item.value === value);
      assert.ok(option !== undefined);
      menu.onSelect?.(option);
    },
  };
}

test('running inspector reads fresh public observations without exposing saved or provider configuration', async () => {
  const { readRunningInspection } = await subject();
  const f = fixture();
  const first = await readRunningInspection(f.api, '/config');
  assert.equal(first.defaults.model, 'fixture/running');
  assert.equal(first.agents?.[0].model, 'fixture/running');
  assert.equal(first.conversation?.stored?.model, 'fixture/recorded');
  assert.match(first.unavailable.composer ?? '', /baseline|restart|reload/i);
  assert.doesNotMatch(JSON.stringify(first), /provider-credential|provider.*options/);
  f.config.model = 'fixture/applied-later';
  const second = await readRunningInspection(f.api, '/config');
  assert.equal(second.defaults.model, 'fixture/applied-later');
  assert.equal(first.defaults.model, 'fixture/running', 'an observation does not change when another read refreshes');
  assert.deepEqual([...new Set(f.reads)].sort(), ['app.agents', 'config.get', 'session.get', 'session.messages']);
});

test('session and agent failures preserve observable workspace defaults', async () => {
  const { readRunningInspection } = await subject();
  const f = fixture();
  f.agents = null;
  f.sessionFails = true;
  f.historyFails = true;
  const result = await readRunningInspection(f.api, '/config');
  assert.equal(result.defaults.model, 'fixture/running');
  assert.equal(result.agents, undefined);
  assert.match(result.unavailable.agents ?? '', /unavailable/i);
  assert.match(result.unavailable.session ?? '', /unavailable/i);
  assert.match(result.unavailable.history ?? '', /unavailable/i);
  assert.doesNotMatch(JSON.stringify(result), /secret-error/);
});

for (const [label, root] of [
  ['long', `/project/${Array<string>(150).fill('segment').join('/')}`],
  ['control characters in', '/project/tab\tand\nnewline'],
] as const) {
  test(`running inspector preserves ${label} API paths and runtime identity`, async () => {
    const { readRunningInspection } = await subject();
    const f = fixture();
    const directory = `${root}/subdir`;
    Object.assign(f.api.state.path, { worktree: root, directory });
    f.config.plugin = [packageName];
    publishRuntimeBaseline(
      f.config,
      {},
      { root, directory },
      {},
      {},
      {
        observedNativeFiles: 'a'.repeat(64),
        choices: { worker: { model: 'fixture/running' } },
      },
    );
    const result = await readRunningInspection(f.api, '/config');
    assert.deepEqual(f.directories, Array<string>(5).fill(directory), 'every public read uses the exact directory');
    assert.deepEqual(result.location, { root, directory });
    assert.equal(result.unavailable.composer, undefined, 'the full-path runtime marker is recognized');
    assert.equal(result.choices?.worker.model, 'fixture/running');
  });
}

test('conversation observations distinguish the newest incomplete or failed response from a completed response', async () => {
  const { readRunningInspection } = await subject();
  const f = fixture();
  f.messages = [
    {
      info: {
        id: 'done',
        role: 'assistant',
        agent: 'worker',
        providerID: 'fixture',
        modelID: 'old',
        variant: 'low',
        time: { created: 10, completed: 20 },
      },
      parts: [],
    },
    {
      info: {
        id: 'requested',
        role: 'user',
        agent: 'worker',
        model: { providerID: 'fixture', modelID: 'new', variant: 'high' },
        time: { created: 30 },
      },
      parts: [{ text: 'private conversation text' }],
    },
    {
      info: {
        id: 'newest',
        role: 'assistant',
        agent: 'worker',
        providerID: 'fixture',
        modelID: 'new',
        time: { created: 40 },
      },
      parts: [],
    },
  ];
  const incomplete = await readRunningInspection(f.api, '/config');
  assert.equal(incomplete.conversation?.latestRequest?.model, 'fixture/new');
  assert.equal(incomplete.conversation.latestResponse?.status, 'incomplete');
  assert.equal(incomplete.conversation.lastCompletedResponse?.model, 'fixture/old');
  assert.doesNotMatch(JSON.stringify(incomplete), /private conversation text/);
  f.messages = [
    {
      info: {
        id: 'failed',
        role: 'assistant',
        agent: 'worker',
        providerID: 'fixture',
        modelID: 'failed',
        time: { created: 50, completed: 60 },
        error: { data: { message: 'secret-error' } },
      },
    },
  ];
  const failed = await readRunningInspection(f.api, '/config');
  assert.equal(failed.conversation?.latestResponse?.status, 'error');
  assert.equal(failed.conversation.lastCompletedResponse, undefined);
  assert.doesNotMatch(JSON.stringify(failed), /secret-error/);
});

test('native custom options are recursively redacted and bounded before entering the view model', async () => {
  const { readRunningInspection } = await subject();
  const f = fixture();
  f.agents = [
    {
      name: 'worker',
      model: { providerID: 'fixture', modelID: 'running' },
      variant: 'high',
      options: {
        apiKey: 'leak-one',
        nested: [{ authorization: 'leak-two', child: { access_token: 'leak-three', reasoningEffort: 'high' } }],
        maxOutputTokens: 100,
        large: 'x'.repeat(10000),
      },
    },
  ];
  const result = await readRunningInspection(f.api, '/config');
  const rendered = JSON.stringify(result);
  assert.doesNotMatch(rendered, /leak-one|leak-two|leak-three/);
  assert.match(rendered, /redacted/);
  assert.match(rendered, /reasoningEffort/);
  assert.match(rendered, /maxOutputTokens/);
  assert.ok(rendered.length < 6000);
});

test('equal timestamps use native chronological order for the latest request and response', async () => {
  const { readRunningInspection } = await subject();
  const f = fixture();
  f.messages = [
    {
      info: {
        id: 'earlier-request',
        role: 'user',
        agent: 'worker',
        model: { providerID: 'fixture', modelID: 'earlier', variant: 'low' },
        time: { created: 10 },
      },
      parts: [],
    },
    {
      info: {
        id: 'earlier-response',
        role: 'assistant',
        agent: 'worker',
        providerID: 'fixture',
        modelID: 'earlier',
        variant: 'low',
        time: { created: 20, completed: 25 },
      },
      parts: [],
    },
    {
      info: {
        id: 'later-request',
        role: 'user',
        agent: 'worker',
        model: { providerID: 'fixture', modelID: 'later', variant: 'high' },
        time: { created: 10 },
      },
      parts: [],
    },
    {
      info: {
        id: 'later-response',
        role: 'assistant',
        agent: 'worker',
        providerID: 'fixture',
        modelID: 'later',
        variant: 'high',
        time: { created: 20, completed: 30 },
      },
      parts: [],
    },
  ];
  const result = await readRunningInspection(f.api, '/config');
  assert.equal(result.conversation?.latestRequest?.id, 'later-request');
  assert.equal(result.conversation.latestRequest.model, 'fixture/later');
  assert.equal(result.conversation.latestRequest.variant, 'high');
  assert.equal(result.conversation.latestResponse?.id, 'later-response');
  assert.equal(result.conversation.latestResponse.model, 'fixture/later');
  assert.equal(result.conversation.latestResponse.variant, 'high');
  assert.equal(result.conversation.lastCompletedResponse?.id, 'later-response');
});

test('changing effective configuration during a read rejects the mixed observation', async () => {
  const { readRunningInspection } = await subject();
  const f = fixture();
  f.beforeAgents = () => {
    f.config.model = 'fixture/raced';
  };
  await assert.rejects(readRunningInspection(f.api, '/config'), /changed|refresh/i);
});

test('applied parameters come from the running marker independently of saved edits and redact custom credentials', async () => {
  const { openRunning, readRunningInspection } = await subject();
  const f = fixture();
  f.config.plugin = [packageName];
  const state = {
    observedNativeFiles: 'a'.repeat(64),
    revision: { sources: 'b'.repeat(64), effective: 'c'.repeat(64) },
    choices: {
      worker: {
        model: 'fixture/running',
        variant: 'high',
        parameters: {
          temperature: 0.23,
          topP: 0.61,
          options: { nested: [{ api_token: 'applied-credential', reasoningEffort: 'high' }] },
        },
      },
    },
  };
  publishRuntimeBaseline(f.config, {}, { root: '/project', directory: '/project/subdir' }, {}, {}, state);
  const result = await readRunningInspection(f.api, '/config');
  assert.equal(result.choices?.worker.parameters?.temperature, 0.23);
  assert.equal(result.unavailable.composer, undefined);
  assert.doesNotMatch(JSON.stringify(result), /applied-credential/);
  openRunning(result, dialogNavigation(f.api), () => {});
  f.select('parameters');
  f.select('worker');
  assert.equal(f.dialog?.title, 'Applied Composer parameters: worker');
  assert.match((f.dialog as TuiDialogAlertProps).message, /0.23/);
  assert.match((f.dialog as TuiDialogAlertProps).message, /native pins, selected variants and capability limits/);
});

test('republishing the same values with a different marker identity rejects a mixed observation', async () => {
  const { readRunningInspection } = await subject();
  const f = fixture();
  f.config.plugin = [packageName];
  publishRuntimeBaseline(f.config, {}, { root: '/project', directory: '/project/subdir' }, {});
  f.beforeAgents = () => {
    publishRuntimeBaseline(f.config, {}, { root: '/project', directory: '/project/subdir' }, {});
  };
  await assert.rejects(readRunningInspection(f.api, '/config'), /changed|refresh/i);
});

test('agent API disagreement rejects a misleading running agent observation', async () => {
  const { readRunningInspection } = await subject();
  const f = fixture();
  f.agents = [{ name: 'worker', model: { providerID: 'fixture', modelID: 'other' }, variant: 'high' }];
  await assert.rejects(readRunningInspection(f.api, '/config'), /disagree|refresh/i);
});

test('home-route inspection does not request or infer a conversation', async () => {
  const { readRunningInspection } = await subject();
  const f = fixture();
  f.api.route.current.name = 'home';
  const result = await readRunningInspection(f.api, '/config');
  assert.equal(result.conversation, undefined);
  assert.deepEqual([...new Set(f.reads)].sort(), ['app.agents', 'config.get']);
});

test('foreign, missing and stale runtime markers leave native observations usable', async () => {
  const { readRunningInspection } = await subject();
  for (const marker of ['foreign', 'stale', 'missing']) {
    const f = fixture();
    f.config.plugin = [packageName];
    if (marker !== 'missing') {
      publishRuntimeBaseline(
        f.config,
        {},
        { root: marker === 'foreign' ? '/foreign' : '/project', directory: '/project/subdir' },
        {},
      );
    }
    if (marker === 'stale') {
      f.config.model = 'fixture/changed';
    }
    const result = await readRunningInspection(f.api, '/config');
    assert.equal(result.defaults.model, f.config.model);
    assert.equal(result.choices, undefined);
    assert.match(result.unavailable.composer ?? '', /baseline|workspace|changed|reload/i);
  }
});

test('running view exposes useful labels, recorded limitations, and delegates refresh', async () => {
  const { openRunning, readRunningInspection } = await subject();
  const f = fixture();
  let refreshes = 0;
  const navigation = dialogNavigation(f.api);
  openRunning(await readRunningInspection(f.api, '/config'), navigation, () => {
    refreshes++;
  });
  assert.equal(f.dialog?.title, 'Running configuration inspector');
  const menu = f.dialog as TuiDialogSelectProps<string>;
  assert.ok(menu.options.some((item) => item.title === 'Recorded conversation'));
  f.select('refresh');
  assert.equal(refreshes, 1);
  f.select('agents');
  f.select('worker');
  assert.equal(f.dialog.title, 'Running agent: worker');
  assert.match((f.dialog as TuiDialogAlertProps).message, /fixture\/running/);
  navigation.back();
  navigation.back();
  f.select('conversation');
  assert.match((f.dialog as TuiDialogAlertProps).message, /recorded|stored/i);
  assert.match((f.dialog as TuiDialogAlertProps).message, /No recorded|No request|No assistant/i);
  navigation.back();
  f.select('limits');
  assert.match((f.dialog as TuiDialogAlertProps).message, /native TUI.*unavailable/i);
  assert.match((f.dialog as TuiDialogAlertProps).message, /final provider request parameters.*unavailable/i);
  assert.match((f.dialog as TuiDialogAlertProps).message, /next request/i);
});
