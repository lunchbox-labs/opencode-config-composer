import assert from 'node:assert/strict';
import { type ChildProcess, execFile } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import { installPackage } from '../install-package.ts';
import { stopProcess } from './process.ts';
import { launchNativeHost } from './native-host.ts';

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
  const root = await realpath(
    await mkdtemp(join(process.env.INTEGRATION_FIXTURE_ROOT ?? tmpdir(), 'composer integration ')),
  );
  const project = join(root, 'project');
  const configRoot = join(root, 'config', 'opencode');
  const requests: Record<string, unknown>[] = [];
  let output = '';
  let stderr = '';
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  let baseURL: string | undefined;
  let unregister: (() => void) | undefined;
  const consumers = new Set<() => Promise<void>>();
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
      const requestedSkill = /Load ([a-z-]+) now\./.exec(JSON.stringify(body.messages))?.[1];
      const defaultProbe = /Probe native (allow|ask)\./.exec(JSON.stringify(body.messages))?.[1];
      const callSkill = (requestedSkill !== undefined || defaultProbe !== undefined) && !toolReturned;
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
                          function: {
                            name: defaultProbe === undefined ? 'skill' : `permission_default_${defaultProbe}`,
                            arguments: defaultProbe === undefined ? JSON.stringify({ name: requestedSkill }) : '{}',
                          },
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
    const results = await Promise.allSettled([...consumers].map((cleanup) => cleanup()));
    if (child !== undefined && exited !== undefined) {
      await stopProcess(child, exited);
      unregister?.();
    }
    child = undefined;
    baseURL = undefined;
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result): unknown => result.reason),
        'Fixture consumers failed to stop',
      );
    }
  };
  t.after(async () => {
    try {
      await stop();
    } finally {
      provider.closeAllConnections();
      provider.close();
    }
    const diagnostics = process.env.INTEGRATION_ARTIFACT_DIR;
    if (diagnostics !== undefined) {
      await mkdir(diagnostics, { recursive: true });
      // Only synthetic traffic and a bounded host log; never databases or caches.
      await writeFile(join(diagnostics, `${name}.log`), Buffer.from(output).subarray(-65_536));
      await writeFile(
        join(diagnostics, `${name}-requests.txt`),
        Buffer.from(
          JSON.stringify(
            requests.map(({ tools, ...request }) => ({
              ...request,
              // Tool schemas are repeated in every request and crowd out the actual
              // permission/tool results. Keep the names and complete message bodies.
              tools: Array.isArray(tools)
                ? tools.map((tool: { function?: { name?: string } }) => tool.function?.name)
                : tools,
            })),
            null,
            2,
          ),
        ).subarray(-65_536),
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
  const prepared = new Set<string>();
  const prepareDependencies = async (directory: string) => {
    if (prepared.has(directory) || (await stat(directory).catch(() => undefined))?.isDirectory() !== true) {
      return;
    }
    const npm = process.env.npm_execpath;
    assert.ok(npm !== undefined, 'run native tests through npm run');
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      engines: { opencode: string };
    };
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }), {
      flag: 'wx',
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    });
    const installDependencies = async () => {
      await promisify(execFile)(
        process.execPath,
        [
          npm,
          'install',
          '--prefix',
          directory,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--save-exact',
          `@opencode-ai/plugin@${manifest.engines.opencode}`,
        ],
        { cwd: directory, timeout: 120_000 },
      ).catch((error: unknown) => {
        const failure = error as NodeJS.ErrnoException & {
          signal?: string;
          killed?: boolean;
          stdout?: string;
          stderr?: string;
        };
        throw new Error(
          `Native SDK preparation failed in ${directory}: ${JSON.stringify({
            code: failure.code,
            signal: failure.signal,
            killed: failure.killed,
            stdout: failure.stdout?.slice(-4000),
            stderr: failure.stderr?.slice(-4000),
          })}`,
        );
      });
    };
    if (directory === configRoot) {
      // Install the genuine pinned SDK once per fixture. Native loading still
      // validates each isolated directory, without repeating cold npm installs.
      await installDependencies();
    } else {
      const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
      type Dependencies = Partial<Record<(typeof dependencyFields)[number], Record<string, string>>>;
      const target = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const lockBytes = await readFile(join(configRoot, 'package-lock.json'));
      const seed = JSON.parse(lockBytes.toString()) as { packages: Partial<Record<string, Dependencies>> };
      const declared = dependencyFields.flatMap((field) => Object.entries((target as Dependencies)[field] ?? {}));
      const locked = new Map(dependencyFields.flatMap((field) => Object.entries(seed.packages['']?.[field] ?? {})));
      if (
        !locked.has('@opencode-ai/plugin') ||
        !declared.every(([name, specification]) => name === '@opencode-ai/plugin' || locked.get(name) === specification)
      ) {
        // Additional or differently specified dependencies need a genuine install.
        await installDependencies();
      } else {
        // Preserve relative .bin links on POSIX; Windows npm shims are regular
        // files. Every directory receives its own copy of the real installed tree.
        await cp(join(configRoot, 'node_modules'), join(directory, 'node_modules'), {
          recursive: true,
          verbatimSymlinks: true,
        });
        await writeFile(
          join(directory, 'package.json'),
          JSON.stringify({
            ...target,
            dependencies: { ...target.dependencies, '@opencode-ai/plugin': manifest.engines.opencode },
          }),
        );
        // Native OpenCode checks this root lock's dependency names before loading;
        // node_modules/.package-lock.json alone still triggers a native reinstall.
        await writeFile(join(directory, 'package-lock.json'), lockBytes);
      }
    }
    const metadata = JSON.parse(
      await readFile(join(directory, 'node_modules/@opencode-ai/plugin/package.json'), 'utf8'),
    ) as { version: string };
    assert.equal(metadata.version, manifest.engines.opencode);
    prepared.add(directory);
  };
  let environment = isolatedEnvironment(root);
  const prepareConfigurationDependencies = async (additionalProjects: readonly string[] = []) => {
    const additionalDirectories: string[] = [];
    for (const directory of additionalProjects) {
      const canonical = await realpath(directory);
      const within = relative(root, canonical);
      assert.ok(
        !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`),
        'additional native projects must remain within this isolated fixture',
      );
      const configuration = await realpath(join(canonical, '.opencode'));
      const configurationWithin = relative(root, configuration);
      assert.ok(
        !isAbsolute(configurationWithin) && configurationWithin !== '..' && !configurationWithin.startsWith(`..${sep}`),
        'additional native configuration directories must remain within this isolated fixture',
      );
      additionalDirectories.push(configuration);
    }
    // Prepare the genuine SDK seed first, then copy it into isolated config dirs.
    for (const directory of [
      configRoot,
      join(root, '.opencode'),
      join(project, '.opencode'),
      ...additionalDirectories,
    ]) {
      await prepareDependencies(directory);
    }
  };
  const start = async (
    options: {
      variables?: Record<string, string>;
      configContent?: Record<string, unknown>;
      configurationAlias?: string;
    } = {},
  ) => {
    assert.equal(child, undefined, 'stop the host before restarting');
    assert.ok(
      Object.keys(options.variables ?? {}).every((name) => name.startsWith('COMPOSER_FIXTURE_')),
      'only explicit synthetic fixture variables may supplement the isolated environment',
    );
    if (options.configurationAlias !== undefined) {
      assert.equal(
        await realpath(options.configurationAlias),
        await realpath(configRoot),
        'an explicit native configuration alias must refer to this isolated fixture configuration',
      );
    }
    environment = {
      ...isolatedEnvironment(root),
      ...options.variables,
      ...(options.configurationAlias === undefined ? {} : { OPENCODE_CONFIG_DIR: options.configurationAlias }),
      ...(options.configContent === undefined
        ? {}
        : { OPENCODE_CONFIG_CONTENT: JSON.stringify(options.configContent) }),
    };
    await prepareConfigurationDependencies();
    let launchOutput = '';
    ({ child, unregister } = launchNativeHost(project, environment, root));
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
    child.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-65_536);
    });
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
    get stderr() {
      return stderr;
    },
    get pid() {
      return child?.pid;
    },
    get url() {
      assert.ok(baseURL !== undefined, 'start the native host first');
      return baseURL;
    },
    get environment() {
      return { ...environment };
    },
    beforeStop(cleanup: () => Promise<void>) {
      consumers.add(cleanup);
      return () => consumers.delete(cleanup);
    },
    prepareConfigurationDependencies,
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
