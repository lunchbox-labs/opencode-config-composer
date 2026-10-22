import { isDeepStrictEqual } from 'node:util';
import { type ConfigurationView, fieldDetail, roster } from './view.ts';
import { agentFields, commandFields, pointer } from '../composition/document.ts';
import { resolveComposition } from '../composition/runtime.ts';
import { retainedSession, sessionNotice } from './running.ts';
import { expectedRevision } from '../storage.ts';
import { selectionLabel } from './profile.ts';
export const nativePending = (view: ConfigurationView) =>
  !isDeepStrictEqual(view.context.disk, view.context.runtime.observation) ||
  view.context.disk.globalJson !== view.context.runtime.globalJsonBaseline;
function configured(view: ConfigurationView) {
  if (nativePending(view)) {
    return undefined;
  }
  return resolveComposition(
    view.context.source.document,
    view.context.selection.choice,
    view.context.runtime.native,
    view.context.runtime.observation.authority,
  );
}
export function openField(view: ConfigurationView, kind: 'agent' | 'command', name: string, field: string): void {
  const key = `/${kind}/${pointer(name)}/${pointer(field)}`;
  const saved = configured(view)?.decisions[key];
  const applied =
    view.context.runtime.status === 'applied' ? view.context.runtime.candidate?.decisions[key] : undefined;
  const pin =
    kind === 'agent'
      ? Object.entries(
          Object.hasOwn(view.context.disk.authority, name) ? view.context.disk.authority[name].fields : {},
        ).find(([key]) => key === field)?.[1]
      : undefined;
  view.details(
    `${kind} ${name} · ${field}`,
    `${nativePending(view) ? `Native inputs changed; configured effective values await reload.\nOn-disk raw pin awaiting reload: ${pin === undefined ? 'Absent' : JSON.stringify(pin.authored)}${pin === undefined ? '' : `\nSource: ${pin.source.path}`}\nConfigured Composer definitions (raw):\n${JSON.stringify(view.context.source.document, null, 2)}` : `Configured\n${fieldDetail(view, key, saved)}`}\n\nVerified applied instance: ${applied === undefined ? 'Not attested for this field' : JSON.stringify(applied.value)}\n${applied === undefined ? '' : `Applied origin: ${applied.origin.source ?? applied.origin.kind} ${applied.origin.pointer ?? ''}`}\n\n${field === 'model' || field === 'variant' ? 'Native session choices may differ. Use /models and /variants; this view does not predict the next request.' : ''}`,
  );
}
export function openEntity(view: ConfigurationView, kind: 'agent' | 'command', name: string): void {
  const entity = configured(view)?.[kind][name];
  view.nav.menu({
    title: `${kind} ${name}`,
    options: (kind === 'agent' ? agentFields : commandFields).map((field) => ({
      title: field,
      value: field,
      description: nativePending(view)
        ? 'Pending native reload'
        : entity !== undefined && Object.hasOwn(entity, field)
          ? JSON.stringify(entity[field])
          : 'Inherit',
    })),
    onSelect: (option) => view.run(() => openField(view, kind, name, option.value)),
  });
}
export function openEffective(view: ConfigurationView): void {
  let diagnostic: string | undefined;
  let candidate: ReturnType<typeof configured>;
  try {
    candidate = configured(view);
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : 'Invalid configured profile';
  }
  const runtime = view.context.runtime;
  const applied =
    candidate !== undefined &&
    runtime.status === 'applied' &&
    isDeepStrictEqual(expectedRevision(view.context), runtime.revision);
  const status = nativePending(view)
    ? 'Pending native disk changes; reload required'
    : (diagnostic ??
      (applied
        ? 'Configured values match verified applied instance'
        : 'Saved configuration pending; instance values shown separately'));
  view.nav.menu(
    {
      title: 'Configuration',
      placeholder: 'Search…',
      options: [
        {
          title: 'Runtime status and sources',
          value: '\0status',
          description: `${selectionLabel(view.context.selection.choice)} · ${status}`,
        },
        {
          title: 'Reload configurations',
          value: '\0reload',
          description: 'Reload this idle instance; global native JSON changes require server restart',
        },
        { title: 'Shared groups', value: '\0groups', description: 'Membership, order and settings · read only' },
        {
          title: 'Profile definitions',
          value: '\0profiles',
          description: 'Every profile including inactive definitions · read only',
        },
        {
          title: 'Global models and shared exceptions',
          value: '\0globals',
          description: 'Raw configured values and verified applied models',
        },
        {
          title: 'Retained session selection',
          value: '\0session',
          description: 'Native /models and /variants remain independent',
        },
        ...(['agent', 'command'] as const).flatMap((kind) =>
          roster(view, kind).map((name) => ({
            title: `${kind} ${name}`,
            value: `${kind}:${name}`,
            description: nativePending(view)
              ? 'Pending native reload'
              : JSON.stringify(candidate?.[kind][name]?.model ?? 'Inherit native model'),
            disabled: diagnostic !== undefined,
          })),
        ),
      ],
      onSelect: (option) =>
        view.run(async () => {
          const document = view.context.source.document;
          if (option.value === '\0reload') {
            await view.reload();
          } else if (option.value === '\0groups') {
            view.nav.menu({
              title: 'Shared groups',
              options: document.groups.map((group, index) => ({
                title: group.name,
                value: String(index),
                description: `${index + 1}. ${group.description ?? 'Shared membership and settings'}`,
              })),
              onSelect: (item) =>
                view.details(
                  `Shared group ${document.groups[Number(item.value)].name}`,
                  JSON.stringify(document.groups[Number(item.value)], null, 2),
                ),
            });
          } else if (option.value === '\0profiles') {
            view.nav.menu({
              title: 'Profile definitions',
              options: Object.entries(document.profiles).map(([name, profile]) => ({
                title: name,
                value: name,
                description: profile.description ?? 'Raw configured profile',
              })),
              onSelect: (item) =>
                view.details(`Profile ${item.value}`, JSON.stringify(document.profiles[item.value], null, 2)),
            });
          } else if (option.value === '\0globals') {
            view.details(
              'Global models and shared exceptions',
              `Configured (raw)\n${JSON.stringify({ model: document.model, small_model: document.small_model, agent: document.agent, command: document.command }, null, 2)}\n\nVerified applied instance: ${runtime.status === 'applied' ? JSON.stringify({ model: runtime.candidate?.model, small_model: runtime.candidate?.small_model }) : 'Not attested'}\n${nativePending(view) ? 'Native disk inputs await reload; no effective prediction is available.' : ''}`,
            );
          } else if (option.value === '\0status') {
            view.details(
              'Runtime status and sources',
              `${status}\nStored worktree choice: ${selectionLabel(view.context.selection.choice)}\nConfigured default: ${document.defaultProfile ?? 'Shared only'}\nLast loaded selection: ${selectionLabel(runtime.selection?.choice)}\nLast loaded status: ${runtime.status}\n${runtime.diagnostic ?? ''}\nSource: ${view.context.source.path}\nCanonical source: ${view.context.source.canonicalPath}\nWorktree: ${runtime.location.root}\nDirectory: ${runtime.location.directory}\nInstance: ${runtime.id}\nApplied revision: ${runtime.revision?.sources ?? 'Not attested'}\n\nNative discovery: ${JSON.stringify(view.context.disk.context, null, 2)}\n\nGlobal native JSON freshness is checked against the first observation in this plugin's server lifetime; initial host cache freshness cannot be proven.\n\n${sessionNotice}`,
            );
          } else if (option.value === '\0session') {
            const checkpoint = view.nav.checkpoint();
            const text = await retainedSession(view.api);
            if (checkpoint()) {
              view.details('Retained session selection', text);
            }
          } else {
            const kind = option.value.startsWith('agent:') ? 'agent' : 'command';
            openEntity(view, kind, option.value.slice(kind.length + 1));
          }
        }),
    },
    true,
  );
}
