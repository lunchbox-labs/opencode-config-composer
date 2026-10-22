import { resolve } from 'node:path';
import type { TuiDialogSelectProps, TuiPluginApi } from '@opencode-ai/plugin/tui';
import { jsx } from '@opentui/solid/jsx-runtime';
import type { SelectProps } from '@opentui/solid';
import { appliedProfile } from './inspection.ts';

/** dialog.replace supplies the native Dialog wrapper; this content needs no filter input. */
export function fixedMenu(api: TuiPluginApi, props: TuiDialogSelectProps<string>) {
  const options = props.options.filter((option) => option.disabled !== true);
  const theme = api.theme.current;
  const select: SelectProps = {
    options: options.map((option) => ({ name: option.title, description: option.description ?? '' })),
    selectedIndex: Math.max(
      0,
      options.findIndex((option) => option.value === props.current),
    ),
    height: Math.min(options.length * 2, 22),
    width: '100%',
    ref: (node) => {
      // Native dialog Escape restores previous focus on its next timer turn.
      setTimeout(() => {
        if (!node.isDestroyed) {
          node.focus();
        }
      }, 1);
    },
    wrapSelection: true,
    backgroundColor: theme.backgroundPanel,
    focusedBackgroundColor: theme.backgroundPanel,
    textColor: theme.text,
    focusedTextColor: theme.text,
    descriptionColor: theme.textMuted,
    selectedBackgroundColor: theme.primary,
    selectedTextColor: theme.selectedListItemText,
    selectedDescriptionColor: theme.selectedListItemText,
    onChange: (index) => props.onMove?.(options[index]),
    onSelect: (index) => props.onSelect?.(options[index]),
  };
  return jsx('box', {
    paddingLeft: 2,
    paddingRight: 2,
    paddingBottom: 1,
    gap: 1,
    children: [
      jsx('text', { fg: theme.text, children: props.title }),
      jsx('select', { ...select }),
      jsx('text', { fg: theme.textMuted, children: '↑↓ select · enter open · esc back' }),
    ],
  });
}
export function registerProfileSlot(api: TuiPluginApi): void {
  const render = () =>
    jsx('text', {
      fg: api.theme.current.textMuted,
      get children() {
        const directory = resolve(api.state.path.directory);
        const worktree = api.state.path.worktree;
        const profile = appliedProfile(
          api.state.config,
          directory,
          resolve(worktree !== '' && worktree !== '/' ? worktree : directory),
        );
        return profile === undefined ? '' : `Profile: ${profile}`;
      },
    });
  api.slots.register({ slots: { home_prompt_right: render, session_prompt_right: render } });
}
