import { type EditorView, roster, sourceText } from './view.ts';
import {
  createGroup,
  deleteGroup,
  moveGroup,
  renameGroup,
  setDescription,
  setMembers,
} from '../composition/authoring.ts';
import { openAgentSettings, openCommandSettings } from './settings.ts';
import type { Group } from '../composition/document-types.ts';
export function openMembers(view: EditorView, name: string, create = false): void {
  const original = view.context.source.document.groups.find((group) => group.name === name)?.members ?? {};
  const staged = { agent: new Set(original.agent), command: new Set(original.command) };
  view.nav.menu({
    title: `Members · ${name}`,
    placeholder: 'Search…',
    get options() {
      return [
        { title: 'Review changes', value: 'review', description: 'Review staged membership before saving' },
        ...(['agent', 'command'] as const).flatMap((kind) =>
          roster(view, kind).map((member) => ({
            title: `${staged[kind].has(member) ? '✓' : '○'} ${kind} ${member}`,
            value: `${kind}:${member}`,
            description: 'Exact native name',
            category: kind,
          })),
        ),
      ];
    },
    onSelect: (option) =>
      view.run(() => {
        if (option.value === 'review') {
          const members: Group['members'] = { agent: [...staged.agent], command: [...staged.command] };
          return view.review(
            create ? createGroup(sourceText(view), name, members) : setMembers(sourceText(view), name, members),
            `Shared · ${name} · members`,
          );
        }
        const kind = option.value.startsWith('agent:') ? 'agent' : 'command';
        const member = option.value.slice(kind.length + 1);
        if (staged[kind].has(member)) {
          staged[kind].delete(member);
        } else {
          staged[kind].add(member);
        }
        view.nav.refresh();
      }),
  });
}
export function openGroup(view: EditorView, name: string): void {
  const group = view.context.source.document.groups.find((group) => group.name === name);
  if (group === undefined) {
    return;
  }
  const index = view.context.source.document.groups.indexOf(group);
  view.nav.menu({
    title: `Shared · ${name}`,
    options: [
      {
        title: 'Members',
        value: 'members',
        description: `${group.members.agent?.length ?? 0} agents · ${group.members.command?.length ?? 0} commands`,
      },
      { title: 'Agent settings for members', value: 'agent' },
      { title: 'Command settings for members', value: 'command' },
      { title: 'Description', value: 'description', description: group.description ?? 'No description' },
      { title: 'Move up', value: 'up', disabled: index === 0, description: 'Common-group order only' },
      {
        title: 'Move down',
        value: 'down',
        disabled: index === view.context.source.document.groups.length - 1,
        description: 'Common-group order only',
      },
      { title: 'Rename group', value: 'rename' },
      {
        title: 'Delete group',
        value: 'delete',
        description: 'Remove its patches from every profile; native definitions remain',
      },
    ],
    onSelect: (option) =>
      view.run(() => {
        if (option.value === 'members') {
          openMembers(view, name);
        } else if (option.value === 'agent') {
          openAgentSettings(view, { group: name, kind: 'agent' });
        } else if (option.value === 'command') {
          openCommandSettings(view, { group: name, kind: 'command' });
        } else if (option.value === 'up' || option.value === 'down') {
          return view.review(
            moveGroup(sourceText(view), name, option.value === 'up' ? -1 : 1),
            `Shared · ${name} · common order`,
          );
        } else if (option.value === 'delete') {
          return view.review(deleteGroup(sourceText(view), name), `Delete Shared · ${name} and profile references`);
        } else {
          view.nav.prompt({
            title: option.value === 'rename' ? 'Rename group' : `Shared · ${name} · description`,
            value: option.value === 'rename' ? name : (group.description ?? ''),
            onConfirm: (value) =>
              view.defer(() =>
                view.review(
                  option.value === 'rename'
                    ? renameGroup(sourceText(view), name, value)
                    : setDescription(sourceText(view), value === '' ? undefined : value, { group: name }),
                  `Shared · ${name}`,
                ),
              ),
          });
        }
      }),
  });
}
export function openGroups(view: EditorView): void {
  view.nav.menu({
    title: 'Groups · shared',
    placeholder: 'Search…',
    options: [
      ...view.context.source.document.groups.map((group, index) => ({
        title: group.name,
        value: group.name,
        description: `${index + 1}. ${group.description ?? ''} · ${group.members.agent?.length ?? 0} agents · ${group.members.command?.length ?? 0} commands`,
        category: 'Always active · authored order',
      })),
      {
        title: 'Create group',
        value: '\0create',
        description:
          view.context.source.document.groups.length === 0
            ? 'No groups configured'
            : 'Add central exact-name membership',
      },
    ],
    onSelect: (option) =>
      view.run(() => {
        if (option.value === '\0create') {
          view.nav.prompt({
            title: 'New group name',
            onConfirm: (name) => view.defer(() => openMembers(view, name, true)),
          });
        } else {
          openGroup(view, option.value);
        }
      }),
  });
}
