import { realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

// Optional failure evidence from the actual TUI process; never changes host state.
export async function tui(api, options) {
  const samples = [];
  let previous;
  let busy = false;
  const capture = async () => {
    if (busy || api.lifecycle.signal.aborted) {
      return;
    }
    busy = true;
    try {
      const path = { directory: api.state.path.directory, worktree: api.state.path.worktree };
      const canonical = await Promise.allSettled([realpath(path.worktree), realpath(path.directory)]);
      const roots = canonical.map((result) =>
        result.status === 'fulfilled' ? { value: result.value } : { error: String(result.reason) },
      );
      const inside = roots.every((result) => result.value !== undefined)
        ? relative(roots[0].value, roots[1].value)
        : undefined;
      const sample = {
        cwd: process.cwd(),
        bun: process.versions.bun,
        path,
        canonical: roots,
        relative: inside,
        absoluteRelative: inside === undefined ? undefined : isAbsolute(inside),
      };
      const serialized = JSON.stringify(sample);
      if (serialized !== previous) {
        previous = serialized;
        samples.push(sample);
        if (samples.length > 8) {
          samples.shift();
        }
        await writeFile(options.file, Buffer.from(JSON.stringify(samples, null, 2)).subarray(-65_536));
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void capture().catch(() => {}), 500);
  api.lifecycle.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}

export default { id: 'native-path-diagnostics', tui };
