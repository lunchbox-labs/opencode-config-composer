import { type ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';

// POSIX callers spawn a separate process group; Windows uses taskkill's tree mode.
export async function stopProcess(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) {
      return;
    }
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw error;
      }
    }
  };
  const force = setTimeout(() => signalGroup('SIGKILL'), 3000);
  force.unref();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    if (process.platform === 'win32' && child.pid !== undefined) {
      await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000 }).catch(() =>
        child.kill(),
      );
    } else {
      signalGroup('SIGTERM');
    }
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Native process did not exit after termination')), 6000);
        deadline.unref();
      }),
    ]);
  } finally {
    clearTimeout(force);
    clearTimeout(deadline);
    // A descendant can retain the pipes after its parent exits. Kill the entire
    // group even when the parent has already exited, then release our pipe ends.
    if (process.platform !== 'win32') {
      signalGroup('SIGKILL');
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
