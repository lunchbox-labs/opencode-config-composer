import { record } from '../settings.ts';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
export const sessionNotice =
  'Existing sessions can retain their model and variant. Use /models and /variants (Default clears an old variant) to change retained selections. The public API cannot reliably clear every current selection.';
export async function retainedSession(api: TuiPluginApi): Promise<string> {
  const route = api.route.current;
  if (route.name !== 'session' || typeof route.params?.sessionID !== 'string') {
    return sessionNotice;
  }
  const response = await api.client.session.get({ sessionID: route.params.sessionID });
  if (response.error !== undefined) {
    return sessionNotice;
  }
  const value: unknown = response.data;
  const session = record(value) ? value : {};
  return `${sessionNotice}\n\nStored session fallback: ${JSON.stringify({ model: session.model, agent: session.agent })}. Current TUI selection and final request parameters are unavailable.`;
}
