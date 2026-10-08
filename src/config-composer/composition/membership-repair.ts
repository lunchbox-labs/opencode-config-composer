import { type FileEdit, type FilePlan, type SourceSnapshot, editJson } from '../storage.ts';
import { SettingsError } from '../settings.ts';
import { planDefinition } from './authoring.ts';
import { type CompositionScope, type ScopeChange, planScope } from './activation.ts';
import { parseCompositionDocument } from './document.ts';

export type MemberKind = 'agents' | 'skills' | 'commands' | 'prompts';
export interface MembershipRepairDraft {
  members?: { group: string; kind: MemberKind; members: string[] }[];
  groups?: { name: string; sourceId: string }[];
  selection?: { scope: CompositionScope; change: ScopeChange };
}

/** Accumulate only explicit JSONC repairs; retain original bytes and destinations for the save transaction. */
export function planMembershipRepair<S extends SourceSnapshot>(snapshot: S, draft: MembershipRepairDraft): FilePlan<S> {
  const pending = new Map<string, FileEdit>();
  const descriptions: string[] = [];
  const apply = (plan: FilePlan<S>, pointer: (string | number)[], value: unknown) => {
    if (plan.edits.length === 0) {
      return;
    }
    const edit = plan.edits[0];
    const previous = pending.get(edit.file.path);
    pending.set(edit.file.path, {
      ...edit,
      text: editJson(previous?.text ?? (edit.file.text === '' ? '{}\n' : edit.file.text), pointer, value),
    });
    descriptions.push(plan.description);
  };
  const names = new Set<string>();
  for (const group of draft.groups ?? []) {
    if (names.has(group.name)) {
      throw new SettingsError(`Duplicate new repair group ${group.name}.`);
    }
    names.add(group.name);
    apply(
      planDefinition(snapshot, { operation: 'create', registry: 'componentGroups', ...group }),
      ['componentGroups', group.name],
      {},
    );
  }
  const fields = new Set<string>();
  for (const item of draft.members ?? []) {
    const identity = `${item.kind}:${item.group}`;
    if (fields.has(identity)) {
      throw new SettingsError(`Duplicate membership repair for ${item.group}/${item.kind}.`);
    }
    fields.add(identity);
    apply(
      planDefinition(snapshot, {
        operation: 'patch',
        registry: 'componentGroups',
        name: item.group,
        path: [item.kind],
        value: item.members,
      }),
      ['componentGroups', item.group, item.kind],
      item.members,
    );
  }
  if (draft.selection !== undefined) {
    const { scope, change } = draft.selection;
    if (change.operation === 'create') {
      throw new SettingsError('Repair the membership or choose a profile selection before creating an empty source.');
    }
    apply(planScope(snapshot, scope, change), ['activeProfiles'], change.profiles);
  }
  const edits = [...pending.values()].filter((edit) => edit.text !== edit.file.text);
  for (const edit of edits) {
    parseCompositionDocument(edit.text, edit.file.path);
  }
  return {
    snapshot,
    edits,
    description: descriptions.length === 0 ? 'No membership repair changes' : descriptions.join('\n'),
  };
}
