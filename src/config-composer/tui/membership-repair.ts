import type { TuiDialogSelectOption } from '@opencode-ai/plugin/tui';
import type { RepairSnapshot } from '../storage.ts';
import type { MemberKind, MembershipRepairDraft } from '../composition/membership-repair.ts';
import { definitionDestinations } from '../composition/authoring.ts';
import { SettingsError, groupName } from '../settings.ts';
import { openActivation } from './activation.ts';

type Action = TuiDialogSelectOption<string> & { run: () => void | Promise<void> };
interface RepairUi {
  menu: (title: string, options: Action[] | (() => Action[])) => void;
  prompt: (title: string, value: string, confirmed: (value: string) => void | Promise<void>) => void;
  alert: (title: string, message: string) => void;
  back: () => void;
  refresh: () => void;
  review: (draft: MembershipRepairDraft) => Promise<void>;
}

export function openMembershipRepair(snapshot: RepairSnapshot, ui: RepairUi): void {
  const draft: MembershipRepairDraft & Required<Pick<MembershipRepairDraft, 'members' | 'groups'>> = {
    members: [],
    groups: [],
  };
  const groups = snapshot.sources.registry.componentGroups ?? {};
  const origin = (name: string) =>
    (Object.hasOwn(snapshot.sources.provenance, `/componentGroups/${name}`)
      ? snapshot.sources.provenance[`/componentGroups/${name}`].sourceId
      : undefined) ?? 'Native agent membership';
  const members = (group: string, kind: MemberKind) => {
    const existing = draft.members.find((item) => item.group === group && item.kind === kind);
    const pending = [...(existing?.members ?? groups[group][kind] ?? [])];
    const available =
      kind === 'agents'
        ? snapshot.agents.map((agent) => agent.name)
        : Object.keys(snapshot.sources.registry.components?.[kind] ?? {});
    const original = groups[group][kind] ?? [];
    ui.menu(`Repair ${group}: ${kind}`, () => [
      {
        title: 'Keep membership changes in draft',
        value: '+keep',
        description: 'No files change until the complete repair is reviewed and saved',
        run: () => {
          draft.members = [
            ...draft.members.filter((item) => item !== existing),
            { group, kind, members: [...pending] },
          ];
          ui.back();
        },
      },
      ...[...new Set([...original, ...available])].map((member) => ({
        title: `${pending.includes(member) ? '✓ ' : ''}${member}`,
        value: `member:${member}`,
        description: available.includes(member)
          ? 'Explicit JSONC member'
          : 'Unavailable or disabled; remove from this group',
        run: () => {
          const index = pending.indexOf(member);
          if (index < 0) {
            if (!available.includes(member)) {
              throw new SettingsError('That member is unavailable or disabled. Choose an available member.');
            }
            pending.push(member);
          } else {
            pending.splice(index, 1);
          }
          ui.refresh();
        },
      })),
    ]);
  };
  const newGroup = () =>
    ui.prompt(
      'Define missing component group',
      Object.hasOwn(groups, snapshot.diagnostic.group) ? '' : snapshot.diagnostic.group,
      (value) => {
        const name = groupName(value.trim());
        if (Object.hasOwn(groups, name) || draft.groups.some((group) => group.name === name)) {
          throw new SettingsError('That group already exists or is in the repair draft.');
        }
        ui.menu(
          'Save new group in…',
          definitionDestinations(snapshot).map((file) => ({
            title: file.path,
            value: file.path,
            run: () => {
              draft.groups.push({ name, sourceId: file.path });
              ui.back();
              ui.back();
            },
          })),
        );
      },
    );
  ui.menu('Repair invalid memberships', () => [
    {
      title: 'Review complete repair…',
      value: '+review',
      description: `${draft.members.length} membership edits · ${draft.groups.length} new groups${draft.selection === undefined ? '' : ` · ${draft.selection.scope} activation edit`}`,
      run: () => ui.review(structuredClone(draft)),
    },
    {
      title: 'Inspect saved membership error',
      value: '+diagnostic',
      run: () =>
        ui.alert(
          'Saved composition is invalid',
          `${snapshot.diagnostic.message}\n\n${origin(snapshot.diagnostic.group)}\n\nEffective saved configuration is unavailable. Draft edits are checked together before saving; running configuration is not changed by inspection or saving.`,
        ),
    },
    ...Object.keys(groups).map((group) => ({
      title: group,
      value: `group:${group}`,
      description: origin(group),
      run: () =>
        ui.menu(
          `Repair group: ${group}`,
          (['agents', 'skills', 'commands', 'prompts'] as const).map((kind) => ({
            title: `Edit ${kind}`,
            value: kind,
            run: () => members(group, kind),
          })),
        ),
    })),
    { title: 'Define a missing component group…', value: '+group', run: newGroup },
    {
      title: 'Change scoped profile selection…',
      value: '+activation',
      run: () =>
        openActivation(snapshot, {
          menu: ui.menu,
          back: ui.back,
          propose: (scope, change) => {
            if (change.operation === 'create') {
              throw new SettingsError('Select profiles, inherit, or select none for this repair.');
            }
            draft.selection = { scope, change };
            ui.alert(
              'Profile selection kept in repair draft',
              'Return to Repair invalid memberships and review the complete repair before saving.',
            );
            return Promise.resolve();
          },
        }),
    },
    {
      title: 'Discard draft changes',
      value: '+discard',
      run: () => {
        draft.members = [];
        draft.groups = [];
        delete draft.selection;
        ui.refresh();
      },
    },
  ]);
}
