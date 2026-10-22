import type { TuiDialogSelectProps, TuiPluginApi } from '@opencode-ai/plugin/tui';

type Render = () => ReturnType<TuiPluginApi['ui']['DialogAlert']>;
const backValue = '\u0000back';

/** Retain parent views while using V1's replacement-only dialog API. */
export type FixedMenu = (props: TuiDialogSelectProps<string>) => ReturnType<TuiPluginApi['ui']['DialogSelect']>;
export function dialogNavigation(api: TuiPluginApi, fixedMenu: FixedMenu) {
  let frames: Render[] = [];
  let revision = 0;
  let replacing = false;

  const reset = () => {
    frames = [];
    revision++;
  };
  api.lifecycle.signal.addEventListener('abort', reset, { once: true });

  // Bind asynchronous picker results to the view and connection that requested them.
  const checkpoint = () => {
    const active = revision;
    const client = api.client;
    const route = api.route.current;
    const name = route.name;
    const sessionID = name === 'session' ? route.params?.sessionID : undefined;
    return () => {
      const current = api.route.current;
      return (
        !api.lifecycle.signal.aborted &&
        active === revision &&
        client === api.client &&
        current.name === name &&
        (current.name !== 'session' || current.params?.sessionID === sessionID)
      );
    };
  };

  const display = (render: Render) => {
    if (api.lifecycle.signal.aborted) {
      return;
    }
    const client = api.client;
    const route = api.route.current;
    const name = route.name;
    const sessionID = name === 'session' ? route.params?.sessionID : undefined;
    const active = ++revision;
    replacing = true;
    try {
      api.ui.dialog.replace(render, () => {
        if (replacing || active !== revision) {
          return;
        }
        frames.pop();
        const parent = frames.at(-1);
        const closed = ++revision;
        // Native Escape/OK/Cancel clears the dialog after this callback returns.
        queueMicrotask(() => {
          if (closed !== revision) {
            return;
          }
          const current = api.route.current;
          if (
            api.lifecycle.signal.aborted ||
            client !== api.client ||
            api.ui.dialog.open ||
            current.name !== name ||
            (current.name === 'session' && current.params?.sessionID !== sessionID)
          ) {
            reset();
            return;
          }
          if (parent !== undefined) {
            display(parent);
          }
        });
      });
    } finally {
      replacing = false;
    }
  };
  const show = (render: Render, root = false) => {
    if (api.lifecycle.signal.aborted) {
      return;
    }
    if (root) {
      reset();
    }
    frames.push(render);
    display(render);
  };
  const close = () => {
    reset();
    api.ui.dialog.clear();
  };
  const back = () => {
    if (frames.length < 2) {
      close();
      return;
    }
    frames.pop();
    const parent = frames.at(-1);
    if (parent !== undefined) {
      display(parent);
    }
  };
  const select = (props: TuiDialogSelectProps<string>, render: FixedMenu) => {
    let selected = props.current;
    return () =>
      render({
        ...props,
        get current() {
          return selected;
        },
        get options() {
          return frames.length > 1
            ? [
                ...props.options,
                {
                  title: '← Back',
                  value: backValue,
                  description: 'Return to the previous view',
                  category: 'Navigation',
                  footer: 'esc',
                },
              ]
            : props.options;
        },
        onMove: (option) => {
          if (option.value !== backValue) {
            selected = option.value;
          }
          props.onMove?.(option);
        },
        onSelect: (option) => {
          if (option.value === backValue) {
            back();
            return;
          }
          selected = option.value;
          return props.onSelect?.(option);
        },
      });
  };
  const menu = (props: TuiDialogSelectProps<string>, root = false) => show(select(props, api.ui.DialogSelect), root);
  const fixed = (props: TuiDialogSelectProps<string>, root = false) => show(select(props, fixedMenu), root);
  const alert = (props: Parameters<TuiPluginApi['ui']['DialogAlert']>[0]) => show(() => api.ui.DialogAlert(props));
  const confirm = (props: Parameters<TuiPluginApi['ui']['DialogConfirm']>[0]) =>
    show(() => api.ui.DialogConfirm(props));
  return { menu, fixed, alert, confirm, close, reset, checkpoint };
}
