import type { ConfigurationView } from './view.ts';
export function selectionLabel(choice: string | null | undefined): string {
  return choice === undefined
    ? 'Follow configured default'
    : choice === null
      ? 'Shared only'
      : `Pinned profile ${choice}`;
}
export function openProfiles(view: ConfigurationView): void {
  const choice = view.context.selection.choice;
  view.nav.menu(
    {
      title: 'Profiles',
      placeholder: 'Search…',
      options: [
        {
          title: 'Follow configured default',
          value: '\0default',
          description: `${choice === undefined ? '● Selected · ' : ''}${view.context.source.document.defaultProfile ?? 'Shared only (no configured default)'}`,
        },
        {
          title: 'Shared only',
          value: '\0none',
          description: choice === null ? '● Selected' : 'Shared groups and named settings remain active',
        },
        ...Object.entries(view.context.source.document.profiles).map(([name, profile]) => ({
          title: `${choice === name ? '●' : '○'} ${name}`,
          value: `choose:${name}`,
          description: profile.description ?? 'Preview and apply to this worktree',
        })),
      ],
      onSelect: (option) =>
        view.run(() =>
          view.choose(
            option.value === '\0default' ? undefined : option.value === '\0none' ? null : option.value.slice(7),
          ),
        ),
    },
    true,
  );
}
