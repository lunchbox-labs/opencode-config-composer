import { isDeepStrictEqual } from 'node:util';
import { type ConfigurationView, fieldDetail, roster } from './view.ts';
import { agentFields, commandFields, pointer } from '../composition/document.ts';
import { resolveComposition } from '../composition/runtime.ts';
import { retainedSession, sessionNotice } from './running.ts';
import { expectedRevision } from '../storage.ts';
import { selectionLabel } from './profile.ts';
function configured(view: ConfigurationView) {
  return resolveComposition(
    view.context.source.document,
    view.context.selection.choice,
    view.context.runtime.native,
    view.context.runtime.observation.authority,
  );
}
export function openField(view: ConfigurationView, kind: 'agent' | 'command', name: string, field: string): void {
  const key = `/${kind}/${pointer(name)}/${pointer(field)}`;
  const saved = configured(view).decisions[key];
  const applied =
    view.context.runtime.status === 'applied' ? view.context.runtime.candidate?.decisions[key] : undefined;
  view.details(
    `${kind} ${name} · ${field}`,
    `Configured\n${fieldDetail(view, key, saved)}\n\nVerified applied instance: ${applied === undefined ? 'Not attested for this field' : JSON.stringify(applied.value)}\n${applied === undefined ? '' : `Applied origin: ${applied.origin.source ?? applied.origin.kind} ${applied.origin.pointer ?? ''}`}\n\n${field === 'model' || field === 'variant' ? 'Native session choices may differ. Use /models and /variants; this view does not predict the next request.' : ''}`,
  );
}
export function openEntity(view: ConfigurationView, kind: 'agent' | 'command', name: string): void {
  const candidate = configured(view);
  const entities = candidate[kind];
  const entity = Object.hasOwn(entities, name) ? entities[name] : {};
  const membership = Object.hasOwn(candidate.memberships, name) ? candidate.memberships[name] : undefined;
  view.nav.menu({
    title: `${kind} ${name}`,
    options: [
      ...(kind === 'agent'
        ? [
            {
              title: 'groups',
              value: '\0groups',
              description: JSON.stringify(membership?.groups ?? []),
            },
          ]
        : []),
      ...(kind === 'agent' ? agentFields : commandFields).map((field) => ({
        title: field,
        value: field,
        description: Object.hasOwn(entity, field) ? JSON.stringify(entity[field]) : 'Inherit',
      })),
    ],
    onSelect: (option) =>
      view.run(() => {
        if (option.value === '\0groups') {
          view.details(
            `agent ${name} · groups`,
            membership === undefined
              ? 'No declared groups.'
              : `Application order: ${JSON.stringify(membership.groups)}\nSource: ${membership.origin.source ?? 'Native agent configuration'} ${membership.origin.pointer ?? ''}\nEach group applies its shared settings, then its selected profile patch. Later listed groups win overlapping settings.`,
          );
        } else {
          openField(view, kind, name, option.value);
        }
      }),
  });
}
export function openEffective(view: ConfigurationView): void {
  let diagnostic: string | undefined;
  let candidate: ReturnType<typeof configured> | undefined;
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
  const status =
    diagnostic ??
    (applied
      ? 'Saved selection matches verified applied instance'
      : 'Saved selection pending; instance values shown separately');
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
          title: 'Shared groups',
          value: '\0groups',
          description: 'Shared settings · membership belongs to each agent',
        },
        {
          title: 'Profile definitions',
          value: '\0profiles',
          description: 'Every profile including inactive definitions · read only',
        },
        {
          title: 'Global models and shared exceptions',
          value: '\0globals',
          description: 'Loaded definitions and verified applied models',
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
            description: JSON.stringify(candidate?.[kind][name]?.model ?? 'Inherit native model'),
            disabled: diagnostic !== undefined,
          })),
        ),
      ],
      onSelect: (option) =>
        view.run(async () => {
          const document = view.context.source.document;
          if (option.value === '\0groups') {
            view.nav.menu({
              title: 'Shared groups',
              options: Object.entries(document.groups).map(([name, group]) => ({
                title: name,
                value: name,
                description: group.description ?? 'Shared agent settings',
              })),
              onSelect: (item) =>
                view.details(`Shared group ${item.value}`, JSON.stringify(document.groups[item.value], null, 2)),
            });
          } else if (option.value === '\0profiles') {
            view.nav.menu({
              title: 'Profile definitions',
              options: Object.entries(document.profiles).map(([name, profile]) => ({
                title: name,
                value: name,
                description: profile.description ?? 'Loaded profile definition',
              })),
              onSelect: (item) =>
                view.details(`Profile ${item.value}`, JSON.stringify(document.profiles[item.value], null, 2)),
            });
          } else if (option.value === '\0globals') {
            view.details(
              'Global models and shared exceptions',
              `Loaded definitions (raw)\n${JSON.stringify({ model: document.model, small_model: document.small_model, agent: document.agent, command: document.command }, null, 2)}\n\nVerified applied instance: ${runtime.status === 'applied' ? JSON.stringify({ model: runtime.candidate?.model, small_model: runtime.candidate?.small_model }) : 'Not attested'}`,
            );
          } else if (option.value === '\0status') {
            view.details(
              'Runtime status and sources',
              `${status}\nStored worktree choice: ${selectionLabel(view.context.selection.choice)}\nLoaded default: ${document.defaultProfile ?? 'Shared only'}\nLast loaded selection: ${selectionLabel(runtime.selection?.choice)}\nLast loaded status: ${runtime.status}\n${runtime.diagnostic ?? ''}\nSource: ${view.context.source.path}\nCanonical source: ${view.context.source.canonicalPath}\nWorktree: ${runtime.location.root}\nDirectory: ${runtime.location.directory}\nDefinition: ${runtime.definitionId}\nInstance: ${runtime.id}\nApplied revision: ${runtime.revision?.sources ?? 'Not attested'}\n\nNative discovery: ${JSON.stringify(runtime.observation.context, null, 2)}\n\n${sessionNotice}`,
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
