import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import type { Agent, Message, Part, Session } from '@opencode-ai/sdk/v2';
import type { CompositionOverrides } from '../../src/config-composer/composition/document-types.ts';
import { compositionFixture } from './composition-fixture.ts';
import { httpRelay } from './http-relay.ts';
import { nativeTerminal } from './terminal.ts';

type Fixture = Awaited<ReturnType<typeof compositionFixture>>;
type Terminal = Awaited<ReturnType<typeof nativeTerminal>>;
type Relay = Awaited<ReturnType<typeof httpRelay>>;
type History = { info: Message; parts: Part[] }[];

const runningParameters = {
  temperature: 0.31,
  topP: 0.67,
  maxOutputTokens: 144,
  options: { inspectorEnvelope: { marker: 'RUNNING_PARAMETERS', nested: { values: [1, true, null] } } },
};
const pendingParameters = {
  temperature: 0.84,
  topP: 0.91,
  maxOutputTokens: 208,
  options: { inspectorEnvelope: { marker: 'PENDING_PARAMETERS', nested: { values: [2, false, null] } } },
};
const overrides = (model: 'alpha' | 'beta', variant: 'low' | 'high', pending = false): CompositionOverrides => ({
  model: `fixture/${model}`,
  small_model: `fixture/${model}`,
  agents: {
    worker: {
      model: `fixture/${model}`,
      variant,
      parameters: pending ? pendingParameters : runningParameters,
    },
  },
});

async function configure(f: Fixture) {
  await f.write(f.paths.shared, {
    componentGroups: { work: { agents: ['worker'] } },
    profiles: { work: { layers: [{ componentGroup: 'work' }], overrides: overrides('beta', 'high') } },
    activeProfiles: ['work'],
  });
}

function assertWire(captured: Record<string, unknown>, variant: 'low' | 'high') {
  assert.equal(captured.model, 'beta');
  assert.equal(captured.reasoning_effort, variant);
  assert.equal(captured.temperature, runningParameters.temperature);
  assert.equal(captured.top_p, runningParameters.topP);
  assert.equal(captured.max_tokens, runningParameters.maxOutputTokens);
  assert.deepEqual(captured.inspectorEnvelope, runningParameters.options.inspectorEnvelope);
}

async function fileState(path: string) {
  try {
    const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
    return { path, bytes, mtime: metadata.mtimeMs, ctime: metadata.ctimeMs, mode: metadata.mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return { path, absent: true };
  }
}

async function selectionFiles(f: Fixture, state: string) {
  // TUI paths are local to its isolated process and are not a public selection
  // API. Discover their files as well as the server-reported state location.
  const names = ['kv.json', 'model.json', 'session.json'];
  const entries = await readdir(f.host.root, { recursive: true });
  const discovered = entries
    .filter((entry) => names.includes(basename(entry)))
    .map((entry) => join(f.host.root, entry));
  return { discovered, files: [...new Set([...names.map((name) => join(state, name)), ...discovered])].sort() };
}

async function snapshot(f: Fixture, sessionID: string) {
  const path = await f.host.api<{ state: string }>('/path');
  const selections = await selectionFiles(f, path.state);
  const [files, config, agents, sessions, session, history] = await Promise.all([
    Promise.all(
      [
        ...Object.values(f.paths),
        join(f.host.configRoot, 'opencode.jsonc'),
        join(f.host.configRoot, 'tui.jsonc'),
        join(f.host.project, 'opencode.jsonc'),
        join(f.host.project, '.opencode', 'opencode.jsonc'),
        ...selections.files,
      ].map(fileState),
    ),
    f.host.api('/config'),
    f.host.api<Agent[]>('/agent'),
    f.host.api<Session[]>('/session'),
    f.host.api<Session>(`/session/${sessionID}`),
    f.host.api<History>(`/session/${sessionID}/message`),
  ]);
  return {
    files,
    selectionFiles: selections.discovered.sort(),
    config,
    agents,
    sessions: sessions.sort((left, right) => left.id.localeCompare(right.id)),
    session,
    history,
    providerRequests: f.host.requests.length,
  };
}

async function initializedSnapshot(f: Fixture, sessionID: string, terminal: Terminal) {
  await terminal.wait(['Acceptance conversation', 'verified', 'Fixture Beta', 'ctrl+p', 'commands']);
  // nativeTerminal installs its diagnostic registration before launch. Wait for
  // initial native model/KV persistence, then put all inspection inside the guard.
  let previous = await snapshot(f, sessionID);
  for (let attempt = 0; attempt < 30; attempt++) {
    await setTimeout(100);
    const current = await snapshot(f, sessionID);
    if (
      JSON.stringify(current) === JSON.stringify(previous) &&
      current.selectionFiles.some((file) => ['kv.json', 'model.json'].includes(basename(file)))
    ) {
      return current;
    }
    previous = current;
  }
  assert.fail('The initial native TUI state did not settle before inspection');
}

async function unchanged(
  f: Fixture,
  sessionID: string,
  before: Awaited<ReturnType<typeof snapshot>>,
  relay: Relay,
  start: number,
  inspectionOnly = true,
) {
  assert.deepEqual(
    await snapshot(f, sessionID),
    before,
    'inspection preserves source/native bytes and write times, KV/model/session state, runtime config, sessions and history',
  );
  assert.ok(
    relay.requests.slice(start).every((request) => request.method === 'GET'),
    'inspection uses read-only native API calls and never applies, selects a session/model, or submits a prompt',
  );
  if (inspectionOnly) {
    assert.ok(
      !relay.requests.slice(start).some((request) => request.path === '/file/content'),
      'the running inspector does not create a shared-filesystem proof file',
    );
  }
}

async function open(terminal: Terminal) {
  await terminal.command(
    '/compose',
    'Compose',
    'Running configuration inspector',
    'Effective configuration and sources',
  );
  await terminal.choose(
    'Running configuration inspector',
    'Running configuration inspector',
    'Running agents',
    'Refresh',
  );
}

async function refresh(terminal: Terminal, relay: Relay) {
  const count = (path: string) =>
    relay.requests.filter((request) => request.method === 'GET' && request.path === path).length;
  const before = { config: count('/config'), agents: count('/agent') };
  await terminal.choose('Refresh', 'Running configuration inspector', 'Running agents');
  assert.ok(count('/config') > before.config, 'Refresh obtains current native configuration again');
  assert.ok(count('/agent') > before.agents, 'Refresh obtains current native agents again');
}

async function defaults(terminal: Terminal) {
  for (const [field, value] of [
    ['model', 'fixture/beta'],
    ['small_model', 'fixture/beta'],
    ['default_agent', 'worker'],
  ]) {
    await terminal.choose(field, value);
    await terminal.press('\x1b', 'Running configuration inspector');
  }
}

async function agentAndParameters(terminal: Terminal, variant: 'low' | 'high') {
  await terminal.choose('Running agents', 'Running agents');
  await terminal.choose('worker', 'Running agent: worker', 'fixture/beta', variant);
  await terminal.press('\x1b', 'Running agents');
  await terminal.press('\x1b', 'Running configuration inspector');
  await terminal.choose('Applied Composer parameters', 'Applied Composer parameters');
  await terminal.choose(
    'worker',
    'Applied Composer parameters: worker',
    'Configured model-bound Composer contributions',
    'fixture/beta',
    variant,
    'temperature',
    '0.31',
    'topP',
    '0.67',
    'maxOutputTokens',
    '144',
    'RUNNING_PARAMETERS',
    'nested',
  );
  assert.ok(!terminal.text().includes('PENDING_PARAMETERS'), 'applied parameters never come from pending saved edits');
  await terminal.press('\x1b', 'Applied Composer parameters');
  await terminal.press('\x1b', 'Running configuration inspector');
}

async function conversation(terminal: Terminal, before: Awaited<ReturnType<typeof snapshot>>) {
  const user = before.history.filter((message) => message.info.role === 'user').at(-1)?.info;
  const assistant = before.history.filter((message) => message.info.role === 'assistant').at(-1)?.info;
  assert.ok(user?.role === 'user' && assistant?.role === 'assistant');
  assert.deepEqual(user.model, { providerID: 'fixture', modelID: 'beta', variant: 'high' });
  assert.equal(assistant.providerID, 'fixture');
  assert.equal(assistant.modelID, 'beta');
  assert.equal(assistant.variant, 'high');
  assert.deepEqual(before.session.model, { providerID: 'fixture', id: 'beta', variant: 'high' });
  await terminal.choose(
    'Recorded conversation',
    'Stored session fallback',
    'Latest recorded request',
    'Latest recorded response',
    `Message: ${user.id}`,
    `Message: ${assistant.id}`,
    'Model: fixture/beta',
    'Variant: high',
    'Status: completed',
  );
  const visible = terminal.text().replace(/\s+/g, '');
  for (const [heading, next, id] of [
    ['Stored session fallback', 'Latest recorded request', undefined],
    ['Latest recorded request', 'Latest recorded response', user.id],
    ['Latest recorded response', 'Recorded selections can differ', assistant.id],
  ]) {
    const start = visible.indexOf(heading!.replace(/\s+/g, ''));
    const end = visible.indexOf(next!.replace(/\s+/g, ''), start);
    assert.ok(start !== -1 && end > start, `${heading!} remains a distinct visible section`);
    const section = visible.slice(start, end);
    assert.ok(section.includes('Agent:worker'), `${heading!} shows its recorded agent`);
    assert.ok(section.includes('Model:fixture/beta'), `${heading!} shows its recorded provider/model`);
    assert.ok(section.includes('Variant:high'), `${heading!} shows its recorded variant`);
    if (id !== undefined) {
      assert.ok(section.includes(`Message:${id}`), `${heading!} identifies its own recorded message`);
    }
  }
  assert.ok(
    !terminal.text().includes('Current selection: fixture/beta'),
    'recorded tuples are never advertised as current selection',
  );
  await terminal.press('\x1b', 'Running configuration inspector');
  await terminal.choose(
    'API limits',
    'Current native TUI model/variant selection is unavailable',
    'Final provider request parameters are unavailable',
    'do not predict the next request',
  );
  await terminal.press('\x1b', 'Running configuration inspector');
}

test(
  'real terminal running inspector distinguishes applied defaults and parameters from a saved pending preview without writes',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'running-inspector-pending');
    await configure(f);
    await f.host.start();
    const original = await f.send();
    assertWire(original.captured, 'high');
    await f.saveDefinition({
      operation: 'patch',
      registry: 'profiles',
      name: 'work',
      path: ['overrides'],
      value: overrides('alpha', 'low', true),
    });
    assert.equal((await f.editor.snapshot()).resolved.agent.worker.model, 'fixture/alpha');
    const relay = await httpRelay(t, () => f.host.url);
    const terminal = await nativeTerminal(
      { ...f.host, url: relay.url },
      original.session.id,
      'running-inspector-pending',
    );
    const before = await initializedSnapshot(f, original.session.id, terminal);
    const start = relay.requests.length;

    await open(terminal);
    await defaults(terminal);
    await agentAndParameters(terminal, 'high');
    await conversation(terminal, before);
    await refresh(terminal, relay);
    await agentAndParameters(terminal, 'high');
    // Establish the running inspector's guard before entering the saved editor,
    // whose established filesystem verification uses a temporary proof file.
    await unchanged(f, original.session.id, before, relay, start);

    await terminal.press('\x1b', 'Compose');
    await terminal.choose('Effective configuration and sources', 'Saved composition preview');
    for (const [pointer, value] of [
      ['/model', 'fixture/alpha'],
      ['/small_model', 'fixture/alpha'],
      ['/agent/worker/model', 'fixture/alpha'],
      ['/agent/worker/variant', 'low'],
      ['/agent/worker/parameters/temperature', '0.84'],
      ['/agent/worker/parameters/topP', '0.91'],
      ['/agent/worker/parameters/maxOutputTokens', '208'],
    ]) {
      await terminal.choose(pointer, 'Saved preview:', value);
      await terminal.press('\x1b', 'Saved composition preview');
    }
    // The native menu clips longer nested field titles. Select the complete
    // visible options container and verify its pending nested contents.
    await terminal.choose(
      '/agent/worker/parameters/options',
      'Saved preview:',
      'PENDING_PARAMETERS',
      'nested',
      'values',
    );
    assert.ok(terminal.text().replace(/\s+/g, '').includes('[2,false,null]'));
    await terminal.press('\x1b', 'Saved composition preview');
    await terminal.press('\x1b', 'Compose');
    await terminal.choose('Running configuration inspector', 'Running configuration inspector');
    await refresh(terminal, relay);
    await defaults(terminal);
    await terminal.press('\x1b', 'Compose');
    await terminal.press('\x1b', 'Fixture Beta', 'ctrl+p', 'commands');
    // The saved preview is also persistent-state read-only; its transient proof
    // file is outside the running inspector's no-filesystem-probe assertion.
    await unchanged(f, original.session.id, before, relay, start, false);
  },
);

test(
  'real terminal running inspector remains available with invalid saved composition and separates configured variants from recorded history',
  { timeout: 240_000 },
  async (t) => {
    const f = await compositionFixture(t, 'running-inspector-invalid');
    await configure(f);
    await f.host.start();
    const original = await f.send();
    assertWire(original.captured, 'high');
    await f.saveDefinition({
      operation: 'patch',
      registry: 'profiles',
      name: 'work',
      path: ['overrides'],
      value: overrides('beta', 'low'),
    });
    await f.editor.reload();
    // Setup-only control proves the running same-model variant is now low. The
    // retained conversation has no new prompt and still records beta/high.
    assertWire((await f.send()).captured, 'low');
    await f.write(f.paths.shared, {
      componentGroups: { broken: { agents: ['missing-inspector-agent'] } },
      profiles: { broken: { layers: [{ componentGroup: 'broken' }] } },
      activeProfiles: ['broken'],
    });
    await assert.rejects(f.editor.snapshot(), /missing-inspector-agent/);
    const relay = await httpRelay(t, () => f.host.url);
    const terminal = await nativeTerminal(
      { ...f.host, url: relay.url },
      original.session.id,
      'running-inspector-invalid',
    );
    const before = await initializedSnapshot(f, original.session.id, terminal);
    assert.equal(before.agents.find((agent) => agent.name === 'worker')?.variant, 'low');
    const start = relay.requests.length;

    await open(terminal);
    await defaults(terminal);
    await agentAndParameters(terminal, 'low');
    await conversation(terminal, before);
    await refresh(terminal, relay);
    await agentAndParameters(terminal, 'low');
    await unchanged(f, original.session.id, before, relay, start);
    await terminal.press('\x1b', 'Compose');
    await terminal.press('\x1b', 'Fixture Beta', 'ctrl+p', 'commands');
    await open(terminal);
    await conversation(terminal, before);
    await terminal.press('\x1b', 'Compose');
    await terminal.press('\x1b', 'Fixture Beta', 'ctrl+p', 'commands');
    await unchanged(f, original.session.id, before, relay, start);
  },
);
