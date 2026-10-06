import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { installPackage } from '../install-package.ts';
import { stopProcess } from './process.ts';

// Only OS launch settings and network transport for host dependency installation are inherited.
// Provider credentials and personal OpenCode configuration are never inherited.
export function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      [
        'path',
        'systemroot',
        'windir',
        'comspec',
        'pathext',
        'https_proxy',
        'http_proxy',
        'ssl_cert_file',
        'node_extra_ca_certs',
      ].includes(key.toLowerCase())
    ) {
      env[key] = value;
    }
  }
  return {
    ...env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_TEST_HOME: root,
    OPENCODE_DB: join(root, 'sessions.sqlite'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    NO_COLOR: '1',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };
}

export async function nativeHarness(t: TestContext, name: string) {
  // Spaces exercise executable arguments and package/config paths on both platforms.
  const root = await mkdtemp(join(tmpdir(), 'composer integration '));
  const project = join(root, 'project');
  const configRoot = join(root, 'config', 'opencode');
  const requests: Record<string, unknown>[] = [];
  let output = '';
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  let baseURL: string | undefined;
  const provider = createServer((request, response) => {
    const reply = async () => {
      assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk));
        size += chunk.length;
        assert.ok(size < 1_000_000, 'fixture request exceeds 1 MB');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      assert.ok(requests.length <= 200, 'unexpected provider request loop');
      const toolReturned =
        Array.isArray(body.messages) && body.messages.some((message: { role?: string }) => message.role === 'tool');
      const callSkill = JSON.stringify(body.messages).includes('Load included-skill now.') && !toolReturned;
      const base = { id: 'synthetic-response', model: body.model, created: 1 };
      if (body.stream === true) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({
            ...base,
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: callSkill
                  ? {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'fixture-skill',
                          type: 'function',
                          function: { name: 'skill', arguments: JSON.stringify({ name: 'included-skill' }) },
                        },
                      ],
                    }
                  : { role: 'assistant', content: 'verified' },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        response.end(
          `data: ${JSON.stringify({
            ...base,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: callSkill ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            ...base,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'verified' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
    };
    reply().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  const stop = async () => {
    if (child !== undefined && exited !== undefined) {
      await stopProcess(child, exited);
    }
    child = undefined;
    baseURL = undefined;
  };
  t.after(async () => {
    await stop();
    provider.closeAllConnections();
    provider.close();
    const diagnostics = process.env.INTEGRATION_ARTIFACT_DIR;
    if (diagnostics !== undefined) {
      await mkdir(diagnostics, { recursive: true });
      // Only synthetic traffic and a bounded host log; never databases or caches.
      await writeFile(join(diagnostics, `${name}.log`), Buffer.from(output).subarray(-65_536));
      await writeFile(
        join(diagnostics, `${name}-requests.txt`),
        Buffer.from(JSON.stringify(requests, null, 2)).subarray(-65_536),
      );
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await mkdir(project, { recursive: true });
  await mkdir(configRoot, { recursive: true });
  const installed = await installPackage(configRoot);
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert.ok(address !== null && typeof address !== 'string');
  const start = async () => {
    assert.equal(child, undefined, 'stop the host before restarting');
    let launchOutput = '';
    child = spawn(
      process.env.OPENCODE_BIN ?? 'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs'],
      {
        cwd: project,
        env: isolatedEnvironment(root),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    let launchError: Error | undefined;
    child.on('error', (error) => {
      launchError = error;
    });
    exited = once(child, 'exit').catch(() => undefined);
    const capture = (data: Buffer) => {
      output = (output + data.toString()).slice(-65_536);
      launchOutput = (launchOutput + data.toString()).slice(-8192);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    for (let attempt = 0; attempt < 400; attempt++) {
      if (launchError !== undefined) {
        throw launchError;
      }
      assert.equal(child.exitCode, null, `OpenCode exited: ${output}`);
      baseURL = /http:\/\/127\.0\.0\.1:\d+/.exec(launchOutput)?.[0];
      if (baseURL !== undefined) {
        return;
      }
      await setTimeout(100);
    }
    assert.fail(`OpenCode did not start: ${output}`);
  };
  const response = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    assert.ok(baseURL !== undefined, 'start the native host first');
    return fetch(`${baseURL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': project },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).catch((error: unknown) => {
      throw new Error(`${path}: ${String(error)}\n${output.slice(-6000)}`);
    });
  };
  const api = async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
    const result = await response(path, body, method);
    assert.ok(result.ok, `${path}: ${await result.clone().text()}\n${output.slice(-4000)}`);
    return (await result.json()) as T;
  };
  return {
    root,
    project,
    configRoot,
    installed,
    requests,
    providerURL: `http://127.0.0.1:${address.port}/v1`,
    start,
    stop,
    api,
    response,
  };
}
