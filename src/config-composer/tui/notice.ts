import { resolve } from 'node:path';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { diagnosticText } from './configuration-error.ts';
import { runtimeDiagnostic } from './inspection.ts';

/** The host logs and ignores config hook failures; show each published diagnostic once. */
export function registerErrorNotice(api: TuiPluginApi): () => void {
  let shown: string | undefined;
  const check = () => {
    if (api.lifecycle.signal.aborted) {
      return;
    }
    const directory = resolve(api.state.path.directory);
    const worktree = api.state.path.worktree;
    const root = resolve(worktree !== '' && worktree !== '/' ? worktree : directory);
    const diagnostic = runtimeDiagnostic(api.state.config, directory, root);
    if (diagnostic === undefined || diagnostic === shown) {
      return;
    }
    shown = diagnostic;
    api.ui.toast({ variant: 'error', title: 'Config Composer', message: diagnosticText(diagnostic) });
  };
  // The host refreshes its configuration view shortly after connecting and after instance disposal.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = () => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      check();
    }, 1000);
    timers.add(timer);
  };
  check();
  const stops = [
    api.event.on('server.connected', later),
    api.event.on('server.instance.disposed', (event) => {
      if (event.properties.directory === api.state.path.directory) {
        later();
      }
    }),
  ];
  return () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    for (const stop of stops) {
      stop();
    }
  };
}
