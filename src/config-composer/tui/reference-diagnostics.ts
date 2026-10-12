import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { SettingsError } from '../settings.ts';
import { readRuntimeReferenceDiagnostics } from '../composition/runtime-baseline.ts';
import {
  type ComponentInventory,
  type ReferenceDiagnostic,
  readComponentInventory,
  validateReferenceDiagnostics,
} from '../composition/reference-diagnostics.ts';

export async function readHostComponentInventory(
  client: TuiPluginApi['client'],
  directory: string,
  signal: AbortSignal,
): Promise<ComponentInventory> {
  const inventory: ComponentInventory = {};
  const [commands, skills] = await Promise.allSettled([
    (async () => {
      const result = await client.command.list({ directory }, { signal });
      if (result.error !== undefined) {
        throw new SettingsError('Command inventory is unavailable.');
      }
      return readComponentInventory(result.data);
    })(),
    (async () => {
      const result = await client.app.skills({ directory }, { signal });
      if (result.error !== undefined) {
        throw new SettingsError('Skill inventory is unavailable.');
      }
      return readComponentInventory(result.data);
    })(),
  ]);
  if (commands.status === 'fulfilled') {
    inventory.commands = commands.value;
  }
  if (skills.status === 'fulfilled') {
    inventory.skills = skills.value;
  }
  return inventory;
}

/** Read-only, post-bootstrap notices. Inventory errors stay distinct from missing component names. */
export function referenceNotices(api: TuiPluginApi, registrationRoot: string) {
  let state: { diagnostics: ReferenceDiagnostic[]; unavailable?: string } = { diagnostics: [] };
  let lastNotice = '';
  let generation = 0;
  const location = () => {
    const path = api.state.path as { worktree?: string; directory?: string };
    const directory = path.directory ?? registrationRoot;
    return {
      directory,
      root: path.worktree !== undefined && path.worktree !== '' && path.worktree !== '/' ? path.worktree : directory,
    };
  };
  async function refresh(notify = false) {
    const request = ++generation;
    const scope = location();
    const client = api.client;
    const current = () =>
      request === generation &&
      !api.lifecycle.signal.aborted &&
      api.client === client &&
      JSON.stringify(location()) === JSON.stringify(scope);
    const signal = AbortSignal.any([api.lifecycle.signal, AbortSignal.timeout(5000)]);
    let next: typeof state;
    try {
      // Completing this request proves bootstrap has finished before querying inventories.
      const response = await client.config.get({ directory: scope.directory }, { signal });
      if (response.error !== undefined) {
        throw new SettingsError('Running configuration is unavailable.');
      }
      const baseline = readRuntimeReferenceDiagnostics(response.data, scope, registrationRoot);
      const inventory: ComponentInventory = {};
      if (baseline.diagnostics.some((item) => item.status === 'pending')) {
        Object.assign(inventory, await readHostComponentInventory(client, scope.directory, signal));
        // Reject mixed snapshots when an instance reload occurs during discovery.
        const after = await client.config.get({ directory: scope.directory }, { signal });
        if (
          after.error !== undefined ||
          readRuntimeReferenceDiagnostics(after.data, scope, registrationRoot).id !== baseline.id
        ) {
          throw new SettingsError('The running instance changed during reference validation. Refresh the notices.');
        }
      }
      next = { diagnostics: validateReferenceDiagnostics(baseline.diagnostics, inventory) };
    } catch (error) {
      next = {
        diagnostics: [],
        unavailable: `Reference validation is unavailable: ${error instanceof Error ? error.message : 'check the server connection'}`,
      };
    }
    if (!current()) {
      return;
    }
    state = next;
    const issue = next.unavailable !== undefined || next.diagnostics.length > 0;
    const fingerprint = issue ? JSON.stringify([scope, next]) : '';
    if (notify && fingerprint !== '' && fingerprint !== lastNotice) {
      api.ui.toast({
        title: 'Composer reference notices',
        variant: 'warning',
        message:
          'Some references are skipped or not yet verified. Run /compose-configs → Reference notices for details.',
        duration: 10000,
      });
      lastNotice = fingerprint;
    }
    if (!issue) {
      lastNotice = '';
    }
  }
  return { current: () => state, refresh };
}
