import { spawn } from 'node:child_process';
import { registerProcess } from './resources.ts';

/** Functional and interruption fixtures share native launch and outer-runner ownership. */
export function launchNativeHost(project: string, environment: NodeJS.ProcessEnv, root: string) {
  const child = spawn(
    process.env.OPENCODE_BIN ?? 'opencode',
    ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs'],
    { cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
  );
  // Publish before yielding: even startup failures belong to the enclosing runner.
  const unregister = child.pid === undefined ? () => {} : registerProcess(child.pid, root);
  return { child, unregister };
}
