import { SettingsError, record } from '../settings.ts';

export interface ComponentInventory {
  /** Undefined means unavailable, never an empty authoritative registry. */
  commands?: readonly { name: string; source?: string }[];
  skills?: readonly { name: string }[];
}
export interface ReferenceDiagnostic {
  kind: 'agents' | 'commands' | 'skills';
  name: string;
  status: 'missing' | 'disabled' | 'unselected' | 'pending';
  sourceId?: string;
  pointer?: string;
  group?: string;
  profile?: string;
  agent?: string;
  command?: string;
}

/** Only the host chooses identities and duplicate-source winners. Never scan component directories here. */
export function hostReferenceStatus(
  kind: 'commands' | 'skills',
  name: string,
  inventory: ComponentInventory = {},
): 'missing' | 'pending' | undefined {
  if (kind === 'skills' && inventory.skills !== undefined) {
    return inventory.skills.some((item) => item.name === name) ? undefined : 'missing';
  }
  if (inventory.commands === undefined) {
    return 'pending';
  }
  const command = inventory.commands.find((item) => item.name === name);
  if (command === undefined) {
    return 'missing';
  }
  // OpenCode adds every skill as a command unless another command already owns its name.
  // A shadowing command is inconclusive, not evidence that a skill is absent.
  return kind === 'commands' || command.source === 'skill' ? undefined : 'pending';
}

export function validateReferenceDiagnostics(
  diagnostics: readonly ReferenceDiagnostic[],
  inventory: ComponentInventory,
): ReferenceDiagnostic[] {
  return diagnostics.flatMap((item) => {
    if (item.status !== 'pending' || (item.kind !== 'commands' && item.kind !== 'skills')) {
      return [{ ...item }];
    }
    const status = hostReferenceStatus(item.kind, item.name, inventory);
    return status === undefined ? [] : [{ ...item, status }];
  });
}

export function referenceDescription(item: ReferenceDiagnostic): string {
  const state =
    item.status === 'pending'
      ? 'Not verified: host inventory is unavailable or inconclusive'
      : `${item.status}; reference skipped`;
  const context = [
    item.profile !== undefined && `Profile ${item.profile}`,
    item.group !== undefined && `Group ${item.group}`,
    item.agent !== undefined && `Agent ${item.agent}`,
    item.command !== undefined && `Command ${item.command}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return `${item.kind}: ${item.name}\n${state}\n${context}\n${item.sourceId ?? 'Native configuration'}${item.pointer === undefined ? '' : `#${item.pointer}`}`;
}

/** Malformed or duplicate API inventory entries must never masquerade as a complete empty registry. */
export function readComponentInventory(value: unknown): { name: string; source?: string }[] {
  if (!Array.isArray(value)) {
    throw new SettingsError('Host component inventory is unavailable.');
  }
  const names = new Set<string>();
  return value.map((item: unknown) => {
    if (!record(item) || typeof item.name !== 'string' || names.has(item.name)) {
      throw new SettingsError('Host component inventory is malformed or ambiguous.');
    }
    names.add(item.name);
    return { name: item.name, ...(typeof item.source === 'string' ? { source: item.source } : {}) };
  });
}

export function readReferenceDiagnostics(value: unknown): ReferenceDiagnostic[] {
  if (!Array.isArray(value)) {
    throw new SettingsError('Reference diagnostic metadata is invalid.');
  }
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !['agents', 'commands', 'skills'].includes(String(item.kind)) ||
      !['missing', 'disabled', 'unselected', 'pending'].includes(String(item.status)) ||
      typeof item.name !== 'string'
    ) {
      throw new SettingsError('Reference diagnostic metadata is invalid.');
    }
    const kind = item.kind;
    const status = item.status;
    if (
      (kind !== 'agents' && kind !== 'commands' && kind !== 'skills') ||
      (status !== 'missing' && status !== 'disabled' && status !== 'unselected' && status !== 'pending')
    ) {
      throw new SettingsError('Reference diagnostic metadata is invalid.');
    }
    const result: ReferenceDiagnostic = { kind, status, name: item.name };
    for (const key of ['sourceId', 'pointer', 'group', 'profile', 'agent', 'command'] as const) {
      if (item[key] !== undefined) {
        if (typeof item[key] !== 'string') {
          throw new SettingsError('Reference diagnostic context is invalid.');
        }
        result[key] = item[key];
      }
    }
    return result;
  });
}
