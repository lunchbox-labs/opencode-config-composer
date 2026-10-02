import type { TuiDialogSelectProps, TuiPluginApi } from '@opencode-ai/plugin/tui';

type Render = () => ReturnType<TuiPluginApi['ui']['DialogAlert']>;
export type DialogDecoration = (element: ReturnType<Render>, close: () => void) => ReturnType<Render>;
const backValue = '\u0000back';

/** Retain parent views while using V1's replacement-only dialog API. */
export function dialogNavigation(api: TuiPluginApi, decoration?: DialogDecoration) {
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
  const decorate = (element: ReturnType<Render>) => (decoration !== undefined ? decoration(element, close) : element);
  const select = (props: TuiDialogSelectProps<string>) => {
    let selected = props.current;
    return () =>
      decorate(
        api.ui.DialogSelect({
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
        }),
      );
  };
  const menu = (props: TuiDialogSelectProps<string>, root = false) => show(select(props), root);
  const alert = (props: Parameters<TuiPluginApi['ui']['DialogAlert']>[0]) =>
    show(() => decorate(api.ui.DialogAlert(props)));
  const confirm = (props: Parameters<TuiPluginApi['ui']['DialogConfirm']>[0]) =>
    show(() => decorate(api.ui.DialogConfirm(props)));
  const prompt = (props: Parameters<TuiPluginApi['ui']['DialogPrompt']>[0]) => {
    let value = props.value;
    show(() =>
      decorate(
        api.ui.DialogPrompt({
          ...props,
          value,
          onConfirm: (text) => {
            value = text;
            return props.onConfirm?.(text);
          },
        }),
      ),
    );
  };
  return {
    show,
    menu,
    select,
    alert,
    prompt,
    confirm,
    back,
    refresh: () => {
      const current = frames.at(-1);
      if (current !== undefined) {
        display(current);
      }
    },
    close,
    reset,
    checkpoint,
    get canGoBack() {
      return frames.length > 1;
    },
  };
}
