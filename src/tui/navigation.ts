import type { TuiDialogSelectProps, TuiPluginApi } from '@opencode-ai/plugin/tui';

type Element = ReturnType<TuiPluginApi['ui']['DialogAlert']>;
interface Frame {
  render: () => Element;
  size?: TuiPluginApi['ui']['dialog']['size'];
}
const backValue = '\u0000back';

/** Retain parent views while using V1's replacement-only dialog API. */
export type FixedMenu = (props: TuiDialogSelectProps<string>) => Element;
/** Read-only text. Enter runs onConfirm, labelled by action, and otherwise returns like Escape. */
export interface DetailsProps {
  title: string;
  message: string;
  onConfirm?: () => void;
  action?: string;
}
/** `scroll` holds the reader's place while the view's Enter action is open. */
export type DetailsView = (props: DetailsProps & { onConfirm: () => void; scroll: { top: number } }) => Element;
export function dialogNavigation(api: TuiPluginApi, widgets: { fixedMenu: FixedMenu; details: DetailsView }) {
  let frames: Frame[] = [];
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

  const display = (frame: Frame) => {
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
      api.ui.dialog.replace(frame.render, () => {
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
      // Replacement resets the native dialog to its medium size.
      if (frame.size !== undefined) {
        api.ui.dialog.setSize(frame.size);
      }
    } finally {
      replacing = false;
    }
  };
  const show = (frame: Frame, root = false) => {
    if (api.lifecycle.signal.aborted) {
      return;
    }
    if (root) {
      reset();
    }
    frames.push(frame);
    display(frame);
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
  const menu = (props: TuiDialogSelectProps<string>, root = false) =>
    show({ render: select(props, api.ui.DialogSelect) }, root);
  const fixed = (props: TuiDialogSelectProps<string>, root = false) =>
    show({ render: select(props, widgets.fixedMenu) }, root);
  const alert = (props: Parameters<TuiPluginApi['ui']['DialogAlert']>[0]) =>
    show({ render: () => api.ui.DialogAlert(props) });
  const confirm = (props: Parameters<TuiPluginApi['ui']['DialogConfirm']>[0], size?: Frame['size']) =>
    show({ render: () => api.ui.DialogConfirm(props), size });
  const details = (props: DetailsProps) => {
    // Cancelling the Enter action shows this frame again; it reopens where the reader left it.
    const scroll = { top: 0 };
    show({ render: () => widgets.details({ ...props, onConfirm: props.onConfirm ?? back, scroll }), size: 'xlarge' });
  };
  return { menu, fixed, alert, confirm, details, close, reset, checkpoint };
}
