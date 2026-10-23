import { type ConfigurationView, fieldDetail, permissionNotice } from './view.ts';
import { agentFields, commandFields, pointer } from '../composition/document.ts';
import { sameConfigurationValue } from '../composition/runtime-baseline.ts';
import { record } from '../settings.ts';
import { retainedSession, sessionNotice } from './running.ts';
import { inspectionText } from './configuration-error.ts';
import { type Inspection, inspectionAgents } from './inspection.ts';

type InspectionView = Pick<ConfigurationView, 'api' | 'nav' | 'run' | 'details'> & { snapshot: Inspection };
function entry(view: InspectionView, kind: 'agent' | 'command', name: string) {
  const entities = view.snapshot.config[kind] ?? {};
  return Object.hasOwn(entities, name) ? entities[name] : {};
}
function nativeField(view: InspectionView, kind: 'agent' | 'command', name: string, field: string): unknown {
  const item = (kind === 'agent' ? view.snapshot.agents : view.snapshot.commands).find((item) => item.name === name);
  if (item === undefined) {
    return undefined;
  }
  const value: unknown = Reflect.get(item, field === 'top_p' ? 'topP' : field);
  if (field === 'model' && record(value)) {
    return `${String(value.providerID)}/${String(value.modelID)}`;
  }
  return value;
}
function display(value: unknown): string {
  return value === undefined ? 'Inherit' : JSON.stringify(value);
}
function openField(view: InspectionView, kind: 'agent' | 'command', name: string, field: string): void {
  const config = entry(view, kind, name);
  const value = config[field];
  const runtime = view.snapshot.runtime;
  const previous = runtime?.applied[kind]?.[name];
  const matches =
    runtime?.status === 'applied' &&
    Object.hasOwn(config, field) === Object.hasOwn(previous ?? {}, field) &&
    sameConfigurationValue(field, previous?.[field], value);
  const key = `/${kind}/${pointer(name)}/${pointer(field)}`;
  const detail = matches
    ? fieldDetail({ context: { runtime, source: runtime.source } }, key, runtime.candidate?.decisions[key])
    : runtime?.status !== 'applied'
      ? 'Composer source attribution unavailable.'
      : 'Loaded value differs from Composer’s recorded contribution; exact source unavailable.';
  const native = nativeField(view, kind, name, field);
  const available = (kind === 'agent' ? view.snapshot.agents : view.snapshot.commands).some(
    (item) => item.name === name,
  );
  view.details(
    `${kind} ${name} · ${field}`,
    [
      `Loaded configuration contribution: ${display(value)}`,
      detail,
      field === 'permission' && kind === 'agent'
        ? `${permissionNotice}\n\nEffective native permission rules (/agent), in evaluation order:\n${native === undefined ? 'Agent unavailable in the native roster.' : JSON.stringify(native, null, 2)}`
        : available
          ? `Effective native ${field}: ${display(native)}`
          : `${kind === 'agent' ? 'Agent' : 'Command'} unavailable in the native roster.`,
      field !== 'permission' &&
      value !== undefined &&
      native !== undefined &&
      !sameConfigurationValue(field, value, native)
        ? 'Native value differs. Source attribution above covers only the config contribution.'
        : '',
      field === 'model' || field === 'variant'
        ? 'Native session choices may differ. Use /models and /variants; this view does not predict the next request.'
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}
function openEntity(view: InspectionView, kind: 'agent' | 'command', name: string): void {
  const candidate = view.snapshot.runtime?.status === 'applied' ? view.snapshot.runtime.candidate : undefined;
  const memberships = candidate?.memberships ?? {};
  const membership = Object.hasOwn(memberships, name) ? memberships[name] : undefined;
  view.nav.fixed({
    title: `${kind} ${name}`,
    options: [
      ...(kind === 'agent'
        ? [
            {
              title: 'groups',
              value: '\0groups',
              description: candidate === undefined ? 'Unavailable' : JSON.stringify(membership?.groups ?? []),
            },
          ]
        : []),
      ...(kind === 'agent' ? agentFields : commandFields).map((field) => ({
        title: field,
        value: field,
        description: inspectionText(display(nativeField(view, kind, name, field) ?? entry(view, kind, name)[field])),
      })),
    ],
    onSelect: (option) =>
      view.run(() => {
        if (option.value === '\0groups') {
          view.details(
            `agent ${name} · groups`,
            candidate === undefined
              ? 'Loaded membership attribution unavailable.'
              : membership === undefined
                ? 'No declared groups.'
                : `Loaded application order: ${JSON.stringify(membership.groups)}\nSource: ${membership.origin.source ?? 'Native agent configuration'} ${membership.origin.pointer ?? ''}\nEach group applies its shared settings, then its selected profile patch. Later listed groups win overlapping settings.`,
          );
        } else {
          openField(view, kind, name, option.value);
        }
      }),
  });
}
export function openEffective(view: InspectionView): void {
  const { runtime, config } = view.snapshot;
  const document = runtime?.source.document;
  let showBuiltins = false;
  const show = () =>
    view.nav.menu(
      {
        title: 'Configuration',
        placeholder: 'Search…',
        options: [
          {
            title: 'Runtime status and sources',
            value: '\0status',
            description: 'Current loaded server configuration',
          },
          ...(document === undefined
            ? []
            : [
                {
                  title: 'Shared groups',
                  value: '\0groups',
                  description: 'Loaded definitions · membership belongs to each agent',
                },
                { title: 'Profile definitions', value: '\0profiles', description: 'Every loaded profile · read only' },
              ]),
          {
            title: 'Global models and shared exceptions',
            value: '\0globals',
            description: 'Loaded configuration and Composer definitions',
          },
          {
            title: 'Retained session selection',
            value: '\0session',
            description: 'Native /models and /variants remain independent',
          },
          { title: showBuiltins ? 'Hide built-in agents' : 'Show built-in agents', value: '\0builtins' },
          ...inspectionAgents(view.snapshot, showBuiltins).map((name) => ({
            title: `agent ${name}`,
            value: `agent:${name}`,
          })),
          ...[...new Set([...view.snapshot.commands.map((item) => item.name), ...Object.keys(config.command ?? {})])]
            .sort()
            .map((name) => ({ title: `command ${name}`, value: `command:${name}` })),
        ],
        onSelect: (option) =>
          view.run(async () => {
            if (option.value === '\0builtins') {
              showBuiltins = !showBuiltins;
              show();
            } else if (option.value === '\0groups' && document !== undefined) {
              view.nav.menu({
                title: 'Shared groups',
                options: Object.entries(document.groups).map(([name, group]) => ({
                  title: name,
                  value: name,
                  description: group.description,
                })),
                onSelect: (item) =>
                  view.details(`Shared group ${item.value}`, JSON.stringify(document.groups[item.value], null, 2)),
              });
            } else if (option.value === '\0profiles' && document !== undefined) {
              view.nav.menu({
                title: 'Profile definitions',
                options: Object.entries(document.profiles).map(([name, profile]) => ({
                  title: name,
                  value: name,
                  description: profile.description,
                })),
                onSelect: (item) =>
                  view.details(`Profile ${item.value}`, JSON.stringify(document.profiles[item.value], null, 2)),
              });
            } else if (option.value === '\0globals') {
              view.details(
                'Global models and shared exceptions',
                `Current loaded configuration\n${JSON.stringify({ model: config.model, small_model: config.small_model, default_agent: config.default_agent, permission: config.permission }, null, 2)}\n\nLoaded Composer definitions\n${document === undefined ? 'Unavailable' : JSON.stringify({ model: document.model, small_model: document.small_model, models: document.models, agent: document.agent, command: document.command }, null, 2)}`,
              );
            } else if (option.value === '\0status') {
              view.details(
                'Runtime status and sources',
                `Current loaded server configuration\n${runtime?.status === 'applied' ? `Applied profile: ${runtime.candidate?.profile ?? 'Shared only'}` : 'Applied Composer profile unavailable.'}\n${runtime === undefined ? 'Composer source attribution unavailable.' : `Source: ${runtime.source.path}\nLoaded default: ${document?.defaultProfile ?? 'Shared only'}\nStatus: ${runtime.status}\n${runtime.diagnostic ?? ''}`}\nSaved choices awaiting apply are shown in /profiles.\n\n${sessionNotice}`,
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
  show();
}
