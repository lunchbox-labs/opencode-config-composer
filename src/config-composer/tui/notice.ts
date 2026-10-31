import { resolve } from 'node:path';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { createComputed, createRoot, onCleanup, untrack } from 'solid-js';
import { diagnosticText } from './configuration-error.ts';
import { runtimeDiagnostic } from './inspection.ts';

/** Observe the host's shared Solid store, including config refreshes that finish later. */
export function registerErrorNotice(api: TuiPluginApi): () => void {
  if (api.lifecycle.signal.aborted) {
    return () => undefined;
  }
  return createRoot((dispose) => {
    api.lifecycle.signal.addEventListener('abort', dispose, { once: true });
    onCleanup(() => api.lifecycle.signal.removeEventListener('abort', dispose));
    let shown: string | undefined;
    createComputed(() => {
      const directory = resolve(api.state.path.directory);
      const worktree = api.state.path.worktree;
      const root = resolve(worktree !== '' && worktree !== '/' ? worktree : directory);
      const diagnostic = runtimeDiagnostic(api.state.config, directory, root);
      const current = diagnostic === undefined ? undefined : JSON.stringify([directory, root, diagnostic]);
      if (current === shown) {
        return;
      }
      // A successful refresh clears suppression so the same error can recur.
      shown = current;
      if (diagnostic !== undefined) {
        untrack(() =>
          api.ui.toast({ variant: 'error', title: 'Config Composer', message: diagnosticText(diagnostic) }),
        );
      }
    });
    return dispose;
  });
}
