import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import type { nativeHarness } from './harness.ts';
import { killProcessTree } from './process.ts';
import { registerProcess } from './resources.ts';
import { terminalSearch } from './terminal-screen.ts';

export async function nativeTerminal(
  host: Awaited<ReturnType<typeof nativeHarness>>,
  sessionID?: string,
  name = 'compose-terminal',
) {
  const diagnosticModule = join(host.root, 'native-path-diagnostics.mjs');
  const diagnosticFile = join(host.root, `${name}-paths.json`);
  await copyFile(new URL('./fixtures/native-path-diagnostics.mjs', import.meta.url), diagnosticModule);
  const tuiFile = join(host.configRoot, 'tui.jsonc');
  const tuiConfig = JSON.parse(await readFile(tuiFile, 'utf8')) as { plugin?: unknown[] };
  await writeFile(
    tuiFile,
    JSON.stringify({
      ...tuiConfig,
      plugin: [...(tuiConfig.plugin ?? []), [diagnosticModule, { file: diagnosticFile }]],
    }),
  );
  const screen = new headless.Terminal({ cols: 180, rows: 55, scrollback: 0, allowProposedApi: true });
  const child = pty.spawn(
    process.env.OPENCODE_BIN ?? 'opencode',
    ['attach', host.url, '--dir', host.project, ...(sessionID === undefined ? [] : ['--session', sessionID])],
    {
      name: 'xterm-256color',
      cols: 180,
      rows: 55,
      cwd: host.project,
      env: { ...host.environment, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    },
  );
  const unregister = registerProcess(child.pid, host.root);
  const search = terminalSearch(screen);
  let transcript = '';
  let revision = 0;
  let exited = false;
  const text = () =>
    Array.from({ length: screen.rows }, (_, row) => screen.buffer.active.getLine(row)?.translateToString() ?? '').join(
      '\n',
    );
  // xterm answers native device/cursor queries while reconstructing the actual current screen.
  screen.onData((data) => child.write(data));
  child.onData((data) => {
    transcript = (transcript + data).slice(-65_536);
    screen.write(data, () => revision++);
  });
  child.onExit(() => {
    exited = true;
  });
  let stopped = false;
  let detach = () => {};
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      const diagnostics = process.env.INTEGRATION_ARTIFACT_DIR;
      if (diagnostics !== undefined) {
        await mkdir(diagnostics, { recursive: true });
        await writeFile(join(diagnostics, `${name}.txt`), Buffer.from(text()).subarray(-65_536));
        await writeFile(join(diagnostics, `${name}-vt.txt`), Buffer.from(transcript).subarray(-65_536));
        const paths = await readFile(diagnosticFile).catch(() => undefined);
        if (paths !== undefined) {
          await writeFile(join(diagnostics, `${name}-paths.json`), paths.subarray(-65_536));
        }
      }
    } finally {
      try {
        // Reap the group even if its leader exited; retain emergency ownership on failure.
        await killProcessTree(child.pid);
        unregister();
      } finally {
        try {
          // Windows ConPTY owns worker/socket resources even after native process exit.
          child.kill();
        } finally {
          detach();
          screen.dispose();
        }
      }
    }
  };
  detach = host.beforeStop(stop);
  const wait = async (labels: string[], after = -1) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      assert.equal(exited, false, `Native terminal exited:\n${text()}\n${transcript.slice(-4000)}`);
      if (
        revision > after &&
        labels.every((label) => text().replace(/\s+/g, ' ').includes(label.replace(/\s+/g, ' ')))
      ) {
        return;
      }
      await setTimeout(50);
    }
    assert.fail(`Native terminal did not render ${JSON.stringify(labels)}:\n${text()}`);
  };
  const waitInput = async (ready: () => boolean, description: string) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      assert.equal(exited, false, `Native terminal exited:\n${text()}`);
      if (ready()) {
        return;
      }
      await setTimeout(50);
    }
    assert.fail(`Native terminal did not expose ${description}:\n${text()}`);
  };
  const press = async (keys: string, ...labels: string[]) => {
    // Back navigation paints the next menu before its input/key handler is ready.
    // A second Escape during that gap is lost by the native dialog.
    if (keys === '\x1b' && search.pending()) {
      await waitInput(search.focused, 'the menu input before Escape');
    }
    const before = revision;
    child.write(keys);
    if (labels.length > 0) {
      await wait(labels, before);
    }
  };
  const choose = async (label: string, ...next: string[]) => {
    // Command autocomplete and a first menu paint can contain this option before
    // the search input has focus. Wait for native focus, then its actual query echo.
    await waitInput(search.focused, 'a focused select search input');
    // Keep the query within the native input viewport so its complete echo is
    // observable; still require the requested full option label before selecting.
    const query = label.slice(0, 32);
    await press(`\x15${query}`);
    await waitInput(() => search.echoed(query), `the select query ${JSON.stringify(query)}`);
    await wait([label]);
    await press('\r', ...next);
  };
  const command = async (name: string, ...labels: string[]) => {
    await waitInput(search.promptFocused, 'the main conversation input');
    await press(name, name);
    await waitInput(() => search.echoed(name), `the command query ${JSON.stringify(name)}`);
    await press('\r', ...labels);
  };
  return { text, wait, press, choose, command, stop };
}
