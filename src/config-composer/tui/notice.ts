import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { createComputed, createRoot, onCleanup, untrack } from 'solid-js';
import { diagnosticText } from './configuration-error.ts';
import { compositionWarnings, configHookFailureDiagnostic, stateLocation } from './inspection.ts';

const listedWarnings = 3;

function warningText(warnings: string[]): string {
  const listed = warnings.slice(0, listedWarnings).join('\n');
  const more = warnings.length - listedWarnings;
  return diagnosticText(more > 0 ? `${listed}\n…and ${more} more in /view-configs.` : listed);
}

/**
 * Toast a failed composition as an error, and what an applied one skipped as a warning. Observes the host's
 * shared Solid store, including config refreshes that finish later.
 */
export function registerCompositionNotice(api: TuiPluginApi): () => void {
  if (api.lifecycle.signal.aborted) {
    return () => undefined;
  }
  return createRoot((dispose) => {
    api.lifecycle.signal.addEventListener('abort', dispose, { once: true });
    onCleanup(() => api.lifecycle.signal.removeEventListener('abort', dispose));
    let shown: string | undefined;
    createComputed(() => {
      const { directory, root } = stateLocation(api);
      const diagnostic = configHookFailureDiagnostic(api.state.config, directory, root);
      const warnings = diagnostic === undefined ? compositionWarnings(api.state.config, directory, root) : [];
      const current =
        diagnostic === undefined && warnings.length === 0
          ? undefined
          : JSON.stringify([directory, root, diagnostic, warnings]);
      if (current === shown) {
        return;
      }
      // A clean refresh clears suppression so the same notice can recur.
      shown = current;
      if (diagnostic !== undefined) {
        untrack(() =>
          api.ui.toast({ variant: 'error', title: 'Config Composer', message: diagnosticText(diagnostic) }),
        );
      } else if (warnings.length > 0) {
        untrack(() => api.ui.toast({ variant: 'warning', title: 'Config Composer', message: warningText(warnings) }));
      }
    });
    return dispose;
  });
}
