import { type EditorView, sourceText } from './view.ts';
import {
  assignGroupModels,
  createProfile,
  deleteProfile,
  moveGroup,
  renameProfile,
  setDefault,
  setDescription,
  setProfileGroup,
} from '../composition/authoring.ts';
import { openAgentSettings, openCommandSettings, openGlobals, pickModel, pickVariant } from './settings.ts';
function groupChoices(view: EditorView, profile: string, bulk: boolean): void {
  const selected = new Set(
    bulk ? [] : view.context.source.document.profiles[profile].groups?.map((group) => group.name),
  );
  view.nav.menu({
    title: `Profile ${profile} · ${bulk ? 'assign models' : 'choose groups'}`,
    get options() {
      return [
        { title: bulk ? 'Choose model' : 'Review changes', value: '\0review' },
        ...view.context.source.document.groups.map((group) => ({
          title: `${selected.has(group.name) ? '✓' : '○'} ${group.name}`,
          value: group.name,
          description: group.description ?? 'Central membership stays shared',
        })),
      ];
    },
    onSelect: (option) =>
      view.run(() => {
        if (option.value === '\0review') {
          if (bulk) {
            return pickModel(view, `Profile ${profile} · bulk model`, (model) =>
              view.run(() =>
                pickVariant(view, `Profile ${profile} · bulk variant`, model, (variant) =>
                  view.run(() =>
                    view.review(
                      assignGroupModels(sourceText(view), profile, [...selected], model, variant),
                      `Profile ${profile} · ${[...selected].join(', ')}`,
                    ),
                  ),
                ),
              ),
            );
          }
          let text = sourceText(view);
          for (const group of view.context.source.document.groups) {
            text = setProfileGroup(text, profile, group.name, selected.has(group.name));
          }
          return view.review(text, `Profile ${profile} · group patches`);
        }
        if (selected.has(option.value)) {
          selected.delete(option.value);
        } else {
          selected.add(option.value);
        }
        view.nav.refresh();
      }),
  });
}
export function openProfileGroups(view: EditorView, profile: string): void {
  const groups = view.context.source.document.profiles[profile].groups ?? [];
  view.nav.menu({
    title: `Profile ${profile} · groups`,
    options: [
      ...groups.map((group, index) => ({
        title: group.name,
        value: group.name,
        description: `${index + 1}. Profile patch order · membership is shared`,
      })),
      { title: 'Choose group patches', value: '\0groups' },
      { title: 'Assign model to groups', value: '\0models' },
    ],
    onSelect: (option) =>
      view.run(() => {
        if (option.value.startsWith('\0')) {
          groupChoices(view, profile, option.value === '\0models');
          return;
        }
        const name = option.value;
        const index = groups.findIndex((group) => group.name === name);
        view.nav.menu({
          title: `Profile ${profile} · ${name}`,
          options: [
            { title: 'Agent settings for members', value: 'agent' },
            { title: 'Command settings for members', value: 'command' },
            { title: 'Move up', value: 'up', disabled: index === 0, description: 'Profile patch order only' },
            {
              title: 'Move down',
              value: 'down',
              disabled: index === groups.length - 1,
              description: 'Profile patch order only',
            },
            {
              title: 'Remove profile patch',
              value: 'remove',
              description: 'Inherit shared settings; group remains active',
            },
          ],
          onSelect: (action) =>
            view.run(() => {
              if (action.value === 'agent') {
                openAgentSettings(view, { profile, group: name, kind: 'agent' });
              } else if (action.value === 'command') {
                openCommandSettings(view, { profile, group: name, kind: 'command' });
              } else {
                return view.review(
                  action.value === 'remove'
                    ? setProfileGroup(sourceText(view), profile, name, false)
                    : moveGroup(sourceText(view), name, action.value === 'up' ? -1 : 1, profile),
                  `Profile ${profile} · ${name}`,
                );
              }
            }),
        });
      }),
  });
}
export function openProfile(view: EditorView, name: string): void {
  const profile = view.context.source.document.profiles[name];
  view.nav.menu({
    title: `Profile ${name}`,
    options: [
      { title: 'Choose this profile', value: 'choose' },
      { title: 'Group settings', value: 'groups' },
      { title: 'Global models', value: 'globals' },
      { title: 'Description', value: 'description', description: profile.description ?? 'No description' },
      {
        title: 'Set as configured default',
        value: 'default',
        description: 'Changes defaultProfile, not this worktree explicit choice',
      },
      { title: 'Rename profile', value: 'rename' },
      {
        title: 'Delete profile',
        value: 'delete',
        description: 'Other worktrees pinned to this name will need a new choice',
      },
    ],
    onSelect: (option) =>
      view.run(() => {
        if (option.value === 'choose') {
          return view.choose(name);
        }
        if (option.value === 'groups') {
          openProfileGroups(view, name);
          return;
        }
        if (option.value === 'globals') {
          openGlobals(view, name);
          return;
        }
        if (option.value === 'default') {
          return view.review(setDefault(sourceText(view), name), `Configured default · ${name}`);
        }
        if (option.value === 'delete') {
          return view.review(
            deleteProfile(sourceText(view), name),
            `Delete Profile ${name}`,
            view.context.selection.choice === name ? null : view.context.selection.choice,
          );
        }
        view.nav.prompt({
          title: option.value === 'rename' ? 'Rename profile' : `Profile ${name} · description`,
          value: option.value === 'rename' ? name : (profile.description ?? ''),
          onConfirm: (value) =>
            view.defer(() =>
              view.review(
                option.value === 'rename'
                  ? renameProfile(sourceText(view), name, value)
                  : setDescription(sourceText(view), value === '' ? undefined : value, { profile: name }),
                `Profile ${name}`,
                option.value === 'rename' && view.context.selection.choice === name
                  ? value
                  : view.context.selection.choice,
              ),
            ),
        });
      }),
  });
}
export function openProfiles(view: EditorView): void {
  const choice = view.context.selection.choice;
  view.nav.menu({
    title: 'Profile',
    placeholder: 'Search…',
    options: [
      {
        title: 'Use configured default',
        value: '\0default',
        description: `${choice === undefined ? '● Stored mode: follow default · ' : ''}${view.context.source.document.defaultProfile ?? 'No configured default'}`,
      },
      {
        title: 'No profile — keep shared settings',
        value: '\0none',
        description: choice === null ? '● Stored mode: no profile' : 'Shared groups and named settings remain',
      },
      ...Object.entries(view.context.source.document.profiles).map(([name, profile]) => ({
        title: `${choice === name ? '●' : '○'} ${name}`,
        value: `choose:${name}`,
        description: profile.description ?? 'Choose → preview → Apply',
        category: 'Choose',
      })),
      ...Object.keys(view.context.source.document.profiles).map((name) => ({
        title: `Edit ${name}`,
        value: `edit:${name}`,
        description: `Profile ${name} · explicit authoring destination`,
        category: 'Edit',
      })),
      { title: 'Create profile', value: '\0create' },
      { title: 'Remove configured default', value: '\0clear', description: 'Explicit worktree choices remain pinned' },
    ],
    onSelect: (option) =>
      view.run(() => {
        if (option.value === '\0default') {
          return view.choose(undefined);
        }
        if (option.value === '\0none') {
          return view.choose(null);
        }
        if (option.value === '\0create') {
          view.nav.prompt({
            title: 'New profile name',
            onConfirm: (name) =>
              view.defer(() => view.review(createProfile(sourceText(view), name), `Create Profile ${name}`)),
          });
          return;
        }
        if (option.value === '\0clear') {
          return view.review(setDefault(sourceText(view), undefined), 'Remove configured default');
        }
        if (option.value.startsWith('edit:')) {
          openProfile(view, option.value.slice(5));
          return;
        }
        return view.choose(option.value.slice(7));
      }),
  });
}
