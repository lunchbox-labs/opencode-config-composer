import type { PluginInput } from '@opencode-ai/plugin';
import type { PermissionWarning } from './permission-runtime.ts';

export function permissionNotifications(client: PluginInput['client']) {
  let warnings = new Map<string, string>();
  const sessions = new Map<string, string>();
  const notify = async (message: string, recovery = false, deferred = false) => {
    console.error(`[Config Composer] ${message}`);
    try {
      const delivery = client.tui.showToast({
        body: {
          title: 'Config Composer permissions',
          message,
          variant: recovery ? 'info' : 'warning',
          duration: 15000,
        },
      });
      if (deferred) {
        delivery.catch(() => undefined);
      } else {
        await delivery;
      }
    } catch {
      // A notification failure must not discard successfully compiled settings.
    }
  };
  return {
    async applied(next: readonly PermissionWarning[]) {
      const updated = new Map(next.map(({ scope, message }) => [scope, message]));
      for (const [scope, message] of updated) {
        if (warnings.get(scope) !== message) {
          await notify(message, false, true);
        }
      }
      for (const scope of warnings.keys()) {
        if (!updated.has(scope)) {
          await notify(`Permission composition warning resolved for ${scope}.`, true, true);
        }
      }
      warnings = updated;
    },
    async session(sessionID: string, agent: string) {
      const message = [...warnings]
        .filter(([scope]) => scope === 'global' || scope === `agent:${agent}`)
        .map(([, message]) => message)
        .join('\n');
      const previous = sessions.get(sessionID);
      if (message !== previous && (message !== '' || previous !== undefined)) {
        await notify(
          message === '' ? 'Permission composition warnings resolved for this session.' : message,
          message === '',
        );
      }
      sessions.set(sessionID, message);
    },
  };
}
