import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { type NativeMessage, compositionFixture } from './composition-fixture.ts';
import { type RelayRequest, httpRelay } from './http-relay.ts';
import { nativeTerminal } from './terminal.ts';
import type * as Runtime from '../../src/config-composer/composition/runtime-baseline.ts';

const refreshPaths = new Set(['/config', '/config/providers', '/agent']);
const mutations = (requests: RelayRequest[]) => requests.filter((request) => request.method !== 'GET');

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, description: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (ready(value)) {
      return value;
    }
    await setTimeout(50);
  }
  assert.fail(`Native host did not expose ${description}`);
}

test(
  'packaged terminal scoped apply retains native inputs, other instances and real conversation history',
  { timeout: 300_000 },
  async (t) => {
    const f = await compositionFixture(t, 'scoped-apply-terminal');
    const provider = await httpRelay(t, () => f.host.providerURL);
    const nativePath = join(f.host.configRoot, 'opencode.jsonc');
    const native = JSON.parse(await readFile(nativePath, 'utf8')) as {
      model: string;
      provider: { fixture: { options: { baseURL: string } } };
      permission?: Record<string, unknown>;
      agent: Record<string, unknown>;
    };
    native.provider.fixture.options.baseURL = `${provider.url}/v1`;
    native.permission = { edit: 'deny' };
    native.agent.fallback = { mode: 'primary', prompt: 'NATIVE_FALLBACK' };
    native.agent.pinned = { mode: 'primary', prompt: 'NATIVE_PIN', model: 'fixture/beta' };
    await writeFile(nativePath, JSON.stringify(native));
    const source = (model: string, prompt: string) => ({
      componentGroups: { work: { agents: ['worker'], configuration: { model, prompt: { append: [prompt] } } } },
      profiles: { work: { layers: [{ componentGroup: 'work' }] } },
      activeProfiles: ['work'],
    });
    await f.write(f.paths.shared, source('fixture/alpha', 'APPLIED_INITIAL'));
    const observer = join(f.host.root, 'observer');
    await mkdir(join(observer, '.opencode'), { recursive: true });
    await writeFile(join(observer, '.opencode/config-composer.local.jsonc'), '{"activeProfiles":[]}');
    await f.host.start();
    const server = await httpRelay(t, () => f.host.url);
    const { readRuntimeBaseline, readRuntimeRevision } = (await import(
      pathToFileURL(join(f.host.installed.directory, 'dist/config-composer/composition/runtime-baseline.js')).href
    )) as typeof Runtime;
    const { location } = await f.editor.runtime();
    const runtime = async () => readRuntimeRevision(await f.host.api('/config'), location, f.host.configRoot);
    const other = async <T>(path: string) => {
      const response = await fetch(`${f.host.url}${path}`, {
        headers: { 'x-opencode-directory': observer },
        signal: AbortSignal.timeout(60_000),
      });
      assert.ok(response.ok, await response.clone().text());
      return (await response.json()) as T;
    };
    const otherBefore = await other('/config');
    const nativeBefore = await readFile(nativePath, 'utf8');
    const initialRuntime = await runtime();
    const session = await f.host.api<{ id: string }>('/session', { title: 'Scoped apply conversation' });
    const send = async (text: string, agent = 'worker', model?: { providerID: string; modelID: string }) => {
      const before = f.host.requests.length;
      const message = await f.host.api<NativeMessage>(`/session/${session.id}/message`, {
        agent,
        ...(model === undefined ? {} : { model }),
        parts: [{ type: 'text', text }],
      });
      assert.equal(message.info.error, undefined, JSON.stringify(message.info.error));
      assert.ok(message.parts.some((part) => part.text === 'verified'));
      assert.equal(f.host.requests.length, before + 1);
      return { message, captured: f.host.requests.at(-1)! };
    };
    const original = await send('SCOPED_HISTORY_FIRST');
    const historyBefore = await f.history(session.id);
    assert.ok(JSON.stringify(original.captured.messages).includes('APPLIED_INITIAL'));
    const terminal = await nativeTerminal({ ...f.host, url: server.url }, session.id, 'scoped-apply-terminal');
    await terminal.wait(['Scoped apply conversation', 'verified', 'ctrl+p', 'commands']);
    const openApply = async (...labels: string[]) => {
      await terminal.command('/reload-configs', 'Settings saved', ...labels);
    };
    const confirmApply = async (...labels: string[]) => {
      await terminal.choose(
        'Reload now',
        'Apply saved revision?',
        'only this instance',
        'Native JSON edits require restart',
      );
      const start = server.requests.length;
      await terminal.press('\r', ...labels);
      return start;
    };
    const rejectCounts = (start: number) => {
      const requests = server.requests.slice(start);
      assert.ok(
        requests.some((request) => request.path === '/session/status'),
        'apply uses native activity HTTP',
      );
      assert.deepEqual(mutations(requests), [], 'rejected apply makes zero real dispose or global config requests');
      assert.deepEqual(
        requests.filter((request) => refreshPaths.has(request.path)),
        [],
        'rejected apply makes zero runtime refresh requests',
      );
    };
    const closeFailedApply = async () => {
      await terminal.wait(['Settings saved']);
      await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
    };

    await t.test('saved revision remains pending until explicit scoped PTY apply', async () => {
      await f.saveDefinition({
        operation: 'patch',
        registry: 'componentGroups',
        name: 'work',
        path: ['configuration'],
        value: { model: 'fixture/beta', prompt: { append: ['SAVED_PENDING'] } },
      });
      await openApply('is pending');
      assert.deepEqual(await runtime(), initialRuntime, 'save preserves the actual applied publication');
      const pending = await send('SCOPED_HISTORY_PENDING');
      assert.equal(pending.captured.model, 'alpha');
      assert.ok(!JSON.stringify(pending.captured.messages).includes('SAVED_PENDING'));
      const beforeApplyHistory = await f.history(session.id);
      const start = await confirmApply('Composer revision applied');
      const current = await runtime();
      assert.notEqual(current.id, initialRuntime.id);
      assert.notDeepEqual(current.revision, initialRuntime.revision);
      const requests = server.requests.slice(start);
      assert.equal(requests.filter((request) => request.path === '/instance/dispose').length, 1);
      assert.ok(
        requests
          .filter((request) => request.path === '/instance/dispose')
          .every((request) => request.directory === f.host.project),
      );
      assert.ok(
        !requests.some((request) => request.path === '/global/config'),
        'scoped apply never patches cached native globals',
      );
      for (const path of refreshPaths) {
        assert.ok(
          requests.some((request) => request.path === path),
          `real runtime refresh reads ${path}`,
        );
      }
      assert.deepEqual(
        await f.history(session.id),
        beforeApplyHistory,
        'every native conversation info and part survives apply',
      );
      assert.deepEqual(
        await other('/config'),
        otherBefore,
        'another opened native instance retains its exact publication',
      );
      assert.equal(await readFile(nativePath, 'utf8'), nativeBefore);
      const baseline = readRuntimeBaseline(await f.host.api('/config'), location, f.host.configRoot);
      assert.equal(baseline.model, 'fixture/alpha');
      assert.equal(baseline.small_model, 'fixture/alpha');
      assert.equal(baseline.default_agent, 'worker');
      assert.deepEqual(baseline.permission, { edit: 'deny' });
      const continued = await send('SCOPED_HISTORY_AFTER_APPLY');
      assert.equal(continued.captured.model, 'beta');
      assert.ok(JSON.stringify(continued.captured.messages).includes('SAVED_PENDING'));
      for (const text of ['SCOPED_HISTORY_FIRST', 'SCOPED_HISTORY_PENDING']) {
        assert.ok(
          JSON.stringify(continued.captured.messages).includes(text),
          `provider receives earlier native user message ${text}`,
        );
      }
      assert.ok(
        JSON.stringify(continued.captured.messages).includes('verified'),
        'provider receives earlier native assistant message',
      );
      assert.equal((await f.send(undefined, 'fallback')).captured.model, 'alpha');
      assert.equal((await f.send(undefined, 'pinned')).captured.model, 'beta');
      assert.equal(
        (await send('SCOPED_EXPLICIT_MODEL', 'worker', { providerID: 'fixture', modelID: 'alpha' })).captured.model,
        'alpha',
      );
      assert.equal(
        (await send('SCOPED_RETAIN_SELECTION', 'fallback')).captured.model,
        'alpha',
        'native session model selection remains effective',
      );
      assert.deepEqual((await f.history(session.id)).slice(0, historyBefore.length), historyBefore);
      await openApply();
      await terminal.choose(
        'Composer revision',
        'Composition revision',
        'applied against the',
        'running native baseline',
      );
      await terminal.press('\x1b', 'Settings saved');
      await terminal.choose('Apply on next restart', 'ctrl+p', 'commands');
    });

    await t.test('real busy child blocks apply without dispose or refresh, then idle retry succeeds', async () => {
      const busyReceived = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      t.after(() => release.resolve(undefined));
      provider.intercept(async ({ body }) => {
        if (body.toString().includes('SCOPED_BUSY_CHILD')) {
          busyReceived.resolve(undefined);
          await release.promise;
        }
      });
      const child = await f.host.api<{ id: string }>('/session', { title: 'Busy native child', parentID: session.id });
      const request = f.host.api<NativeMessage>(`/session/${child.id}/message`, {
        agent: 'worker',
        parts: [{ type: 'text', text: 'SCOPED_BUSY_CHILD' }],
      });
      const completed = request.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await busyReceived.promise;
      await until(
        () => f.host.api<Partial<Record<string, { type: string }>>>('/session/status'),
        (statuses) => statuses[child.id]?.type === 'busy',
        'actual busy child status',
      );
      const before = await runtime();
      await openApply();
      const start = await confirmApply('Agents are still running', 'retry apply when idle');
      rejectCounts(start);
      assert.deepEqual(await runtime(), before);
      await closeFailedApply();
      release.resolve(undefined);
      const outcome = await completed;
      if ('error' in outcome) {
        throw outcome.error;
      }
      provider.intercept();
      await until(
        () => f.host.api<Partial<Record<string, { type: string }>>>('/session/status'),
        (statuses) => statuses[child.id] === undefined || statuses[child.id]?.type === 'idle',
        'idle child',
      );
      const childHistory = await f.history(child.id);
      await openApply();
      await confirmApply('Composer revision applied');
      assert.notEqual((await runtime()).id, before.id);
      assert.deepEqual(await f.history(child.id), childHistory);
    });

    await t.test('native provider retry state blocks apply without dispose or refresh', async () => {
      let attempts = 0;
      provider.intercept(async ({ body }, response) => {
        if (!body.toString().includes('SCOPED_PROVIDER_RETRY')) {
          return;
        }
        attempts++;
        response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
        response.end(
          JSON.stringify({
            error: { message: 'Synthetic retry gate', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
          }),
        );
      });
      const retrySession = await f.host.api<{ id: string }>('/session', { title: 'Native retrying conversation' });
      const request = f.host.api<NativeMessage>(`/session/${retrySession.id}/message`, {
        agent: 'worker',
        parts: [{ type: 'text', text: 'SCOPED_PROVIDER_RETRY' }],
      });
      const completed = request.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      t.after(async () => {
        await f.host.api(`/session/${retrySession.id}/abort`, {}).catch(() => undefined);
      });
      const statuses = await until(
        () => f.host.api<Partial<Record<string, { type: string; attempt?: number }>>>('/session/status'),
        (statuses) => statuses[retrySession.id]?.type === 'retry',
        'actual native retry status',
      );
      assert.ok(attempts >= 1);
      assert.equal(statuses[retrySession.id]?.attempt, 1);
      const before = await runtime();
      await openApply();
      const start = await confirmApply('Agents are still running', 'retry apply when idle');
      rejectCounts(start);
      assert.deepEqual(await runtime(), before);
      await closeFailedApply();
      await f.host.api(`/session/${retrySession.id}/abort`, {});
      await completed;
      provider.intercept();
      await until(
        () => f.host.api<Partial<Record<string, { type: string }>>>('/session/status'),
        (statuses) => statuses[retrySession.id] === undefined || statuses[retrySession.id]?.type === 'idle',
        'aborted retry idle',
      );
    });

    await t.test(
      'source bytes changed during real activity HTTP prevent disposal and all runtime refresh',
      async () => {
        const originalSource = await readFile(f.paths.shared, 'utf8');
        const before = await runtime();
        let injected = false;
        try {
          await openApply();
          server.interceptResponse(async (request) => {
            if (request.path === '/session/status' && !injected) {
              assert.equal(request.status, 200, 'the activity race forwards a successful genuine native response');
              injected = true;
              await writeFile(f.paths.shared, originalSource + '\n// Concurrent saved-source edit\n');
            }
          });
          const start = await confirmApply('Settings changed', 'Reopen the editor');
          assert.equal(injected, true, 'the race happened inside the real native status request');
          rejectCounts(start);
          assert.deepEqual(await runtime(), before);
          assert.equal(await readFile(nativePath, 'utf8'), nativeBefore);
          assert.deepEqual(await other('/config'), otherBefore);
          await closeFailedApply();
        } finally {
          server.interceptResponse();
          await writeFile(f.paths.shared, originalSource);
        }
      },
    );

    await t.test('saved native JSON edit requires restart and cannot claim scoped application', async () => {
      const before = await runtime();
      const beforeHistory = await f.history(session.id);
      const editedNative = JSON.stringify({ ...native, model: 'fixture/beta' });
      await writeFile(nativePath, editedNative);
      try {
        await openApply();
        const start = await confirmApply(
          'Native JSON configuration changed',
          'Restart OpenCode',
          'Saved changes are retained',
        );
        const requests = server.requests.slice(start);
        assert.deepEqual(mutations(requests), []);
        assert.deepEqual(
          requests.filter((request) => refreshPaths.has(request.path)),
          [],
        );
        assert.ok(
          !requests.some((request) => request.path === '/session/status'),
          'native cache guard rejects before activity HTTP',
        );
        assert.deepEqual(await runtime(), before);
        assert.deepEqual(await f.history(session.id), beforeHistory);
        assert.equal(await readFile(nativePath, 'utf8'), editedNative, 'rejected apply retains the saved native edit');
        assert.equal(
          (await f.send(undefined, 'fallback')).captured.model,
          'alpha',
          'running native cache retains its original default',
        );
        await closeFailedApply();
      } finally {
        await writeFile(nativePath, nativeBefore);
      }
    });
    assert.deepEqual(await other('/config'), otherBefore);

    await t.test(
      'real native restart applies native JSON and preserves stored conversations and model selection',
      async () => {
        const beforeHistory = await f.history(session.id);
        await writeFile(nativePath, JSON.stringify({ ...native, model: 'fixture/beta' }));
        await f.host.stop();
        await f.host.start();
        const baseline = readRuntimeBaseline(await f.host.api('/config'), location, f.host.configRoot);
        assert.equal(baseline.model, 'fixture/beta');
        assert.equal(baseline.small_model, 'fixture/alpha');
        assert.deepEqual(await f.history(session.id), beforeHistory, 'restart retains every native message and part');
        assert.equal(
          (await f.send(undefined, 'fallback')).captured.model,
          'beta',
          'fresh native session observes saved model after restart',
        );
        const continued = await send('SCOPED_HISTORY_AFTER_RESTART', 'fallback');
        assert.equal(continued.captured.model, 'alpha', 'existing session retains its explicit native model selection');
        assert.ok(JSON.stringify(continued.captured.messages).includes('SCOPED_HISTORY_FIRST'));
        assert.deepEqual((await f.history(session.id)).slice(0, beforeHistory.length), beforeHistory);
      },
    );
  },
);
