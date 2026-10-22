import { type EditorView, fieldDetail, roster } from './view.ts';
import { agentFields, commandFields, pointer } from '../composition/document.ts';
import { resolveComposition } from '../composition/runtime.ts';
import { openAgentSettings, openGlobals } from './settings.ts';
import { retainedSession, sessionNotice } from './running.ts';
function configured(view: EditorView) {
  return resolveComposition(
    view.context.source.document,
    view.context.selection.choice,
    view.context.runtime.native,
    view.context.runtime.observation.authority,
  );
}
export function openField(view: EditorView, kind: 'agent' | 'command', name: string, field: string): void {
  const key = `/${kind}/${pointer(name)}/${pointer(field)}`;
  const saved = configured(view).decisions[key];
  const applied =
    view.context.runtime.status === 'applied' ? view.context.runtime.candidate?.decisions[key] : undefined;
  view.details(
    `${kind} ${name} · ${field}`,
    `Configured\n${fieldDetail(view, key, saved)}\n\nVerified applied instance: ${applied === undefined ? 'Not attested for this field' : JSON.stringify(applied.value)}\n\n${field === 'model' || field === 'variant' ? 'Native session choices may differ. Use /models and /variants; this view does not predict the next request.' : ''}`,
  );
}
export function openEntity(view: EditorView, kind: 'agent' | 'command', name: string): void {
  const candidate = configured(view);
  const entity = candidate[kind][name] ?? {};
  view.nav.menu({
    title: `${kind} ${name}`,
    options: [
      ...(kind === 'agent' ? agentFields : commandFields).map((field) => ({
        title: field,
        value: field,
        description: Object.hasOwn(entity, field) ? JSON.stringify(entity[field]) : 'Inherit',
      })),
      { title: 'Edit shared exception', value: '\0shared', description: `Shared · ${kind} ${name}` },
      ...Object.keys(view.context.source.document.profiles).map((profile) => ({
        title: `Edit exception in ${profile}`,
        value: `\0profile:${profile}`,
        description: `Profile ${profile} · ${kind} ${name}`,
      })),
    ],
    onSelect: (option) =>
      view.run(() => {
        if (option.value === '\0shared') {
          openAgentSettings(view, { kind, name });
        } else if (option.value.startsWith('\0profile:')) {
          openAgentSettings(view, { kind, name, profile: option.value.slice(9) });
        } else {
          openField(view, kind, name, option.value);
        }
      }),
  });
}
export function openEffective(view: EditorView): void {
  let diagnostic: string | undefined;
  try {
    configured(view);
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : 'Invalid configured profile';
  }
  view.nav.menu({
    title: 'Effective configuration',
    placeholder: 'Search…',
    options: [
      {
        title: 'Runtime status',
        value: '\0status',
        description: diagnostic ?? view.context.runtime.diagnostic ?? 'Configured and verified-applied values',
      },
      {
        title: 'Apply saved changes',
        value: '\0apply',
        description: 'Retry a saved pending document or profile choice',
      },
      { title: 'Shared global models', value: '\0globals', description: 'model / small_model · Shared destination' },
      {
        title: 'Retained session selection',
        value: '\0session',
        description: 'Native /models and /variants remain independent',
      },
      ...(['agent', 'command'] as const).flatMap((kind) =>
        roster(view, kind).map((name) => ({
          title: `${kind} ${name}`,
          value: `${kind}:${name}`,
          description: JSON.stringify(view.context.runtime.candidate?.[kind][name]?.model ?? 'Inherit native model'),
          disabled: diagnostic !== undefined,
        })),
      ),
    ],
    onSelect: (option) =>
      view.run(async () => {
        if (option.value === '\0apply') {
          await view.retry();
        } else if (option.value === '\0globals') {
          openGlobals(view);
        } else if (option.value === '\0status') {
          view.details(
            'Runtime status',
            `${diagnostic ?? view.context.runtime.diagnostic ?? 'Composer applied'}\nSource: ${view.context.source.path}\nWorktree: ${view.context.runtime.location.root}\nApplied revision: ${view.context.runtime.revision?.sources ?? 'Not attested'}\n\n${sessionNotice}`,
          );
        } else if (option.value === '\0session') {
          const current = view.nav.checkpoint();
          const text = await retainedSession(view.api);
          if (current()) {
            view.details('Retained session selection', text);
          }
        } else {
          const kind = option.value.startsWith('agent:') ? 'agent' : 'command';
          openEntity(view, kind, option.value.slice(kind.length + 1));
        }
      }),
  });
}
