import { resolve } from 'node:path';
import type { TuiDialogSelectProps, TuiPluginApi } from '@opencode-ai/plugin/tui';
import { jsx } from '@opentui/solid/jsx-runtime';
import { type ScrollBoxProps, type SelectProps, useTerminalDimensions } from '@opentui/solid';
import { onCleanup } from 'solid-js';
import type { DetailsView } from '../../tui/navigation.ts';
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
/** Read-only text that scrolls inside the native dialog, which keeps Escape and backdrop dismissal. */
export function detailsView(api: TuiPluginApi, props: Parameters<DetailsView>[0]) {
  const theme = api.theme.current;
  const dimensions = useTerminalDimensions();
  let view: { scrollTop: number } | undefined;
  let restore = props.scroll.top > 0;
  const scroll: ScrollBoxProps = {
    verticalScrollbarOptions: {
      trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
    },
    ref: (node) => {
      view = node;
      // The session route binds page, home and end keys to scroll the conversation and close any dialog.
      // This newer focused layer takes precedence; the scroll box itself handles arrows and j/k.
      onCleanup(
        api.keymap.registerLayer({
          target: node,
          targetMode: 'focus',
          bindings: [
            { key: 'pageup', desc: 'Scroll up', group: 'Dialog', cmd: () => node.scrollBy(-0.5, 'viewport') },
            { key: 'pagedown', desc: 'Scroll down', group: 'Dialog', cmd: () => node.scrollBy(0.5, 'viewport') },
            { key: 'home', desc: 'Scroll to start', group: 'Dialog', cmd: () => node.scrollTo(0) },
            { key: 'end', desc: 'Scroll to end', group: 'Dialog', cmd: () => node.scrollTo(node.scrollHeight) },
            {
              key: 'return',
              desc: props.action ?? 'Back',
              group: 'Dialog',
              cmd: () => {
                props.scroll.top = node.scrollTop;
                props.onConfirm();
              },
            },
          ],
        }),
      );
      node.focus();
      // Native dialog Escape restores previous focus on its next timer turn.
      setTimeout(() => {
        if (!node.isDestroyed) {
          node.focus();
        }
      }, 1);
    },
    children: jsx('box', {
      // The scroll box has measured its content when this first takes its size, so the saved place is reachable.
      onSizeChange: () => {
        if (restore && view !== undefined) {
          restore = false;
          view.scrollTop = props.scroll.top;
        }
      },
      children: jsx('text', { fg: theme.text, children: props.message }),
    }),
  };
  return jsx('box', {
    paddingLeft: 2,
    paddingRight: 2,
    paddingBottom: 1,
    gap: 1,
    children: [
      jsx('text', { fg: theme.text, flexShrink: 0, children: props.title }),
      jsx('scrollbox', {
        ...scroll,
        // The native dialog starts a quarter down the screen; keep the title and hint visible.
        get maxHeight() {
          const { height } = dimensions();
          return Math.max(1, height - Math.ceil(height / 4) - 7);
        },
      }),
      jsx('text', {
        fg: theme.textMuted,
        flexShrink: 0,
        children: `↑↓ pgup pgdn scroll · ${props.action === undefined ? 'enter/esc back' : `enter ${props.action} · esc back`}`,
      }),
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
