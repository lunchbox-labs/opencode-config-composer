import { isDeepStrictEqual } from 'node:util';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import type { dialogNavigation } from '../../tui/navigation.ts';
import { SettingsError, record } from '../settings.ts';
import { readRuntimeChoices } from '../composition/runtime-baseline.ts';

interface ModelObservation {
  model?: string;
  variant?: string;
  agent?: string;
}
interface MessageObservation extends ModelObservation {
  id: string;
  created?: number;
  completed?: number;
  status?: 'completed' | 'incomplete' | 'error';
}
interface RunningAgent extends ModelObservation {
  name: string;
  temperature?: number;
  topP?: number;
  options?: unknown;
}
interface RunningChoice extends ModelObservation {
  parameters?: Record<string, unknown>;
}
export interface RunningInspection {
  observedAt: number;
  location: { root: string; directory: string };
  defaults: { model?: string; small_model?: string; default_agent?: string };
  agents?: RunningAgent[];
  composerId?: string;
  choices?: Record<string, RunningChoice>;
  conversation?: {
    sessionID: string;
    stored?: ModelObservation;
    latestRequest?: MessageObservation;
    latestResponse?: MessageObservation;
    lastCompletedResponse?: MessageObservation;
  };
  unavailable: { agents?: string; composer?: string; session?: string; history?: string };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }
  let clean = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 31 && (code < 127 || code > 159)) {
      clean += char;
      if (clean.length >= 1000) {
        break;
      }
    }
  }
  return clean === '' ? undefined : clean;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function credentialKey(key: string): boolean {
  const name = key.toLowerCase().replaceAll(/[^a-z]/g, '');
  return (
    ['apikey', 'authorization', 'password', 'passwd', 'secret', 'credential', 'privatekey'].some((part) =>
      name.includes(part),
    ) ||
    name.endsWith('token') ||
    name === 'cookie'
  );
}
function safeOptions(value: unknown): unknown {
  let remaining = 200;
  const copy = (item: unknown, depth = 0): unknown => {
    if (remaining-- <= 0 || depth >= 8) {
      return '[truncated]';
    }
    if (typeof item === 'string') {
      return `${text(item) ?? ''}${item.length > 1000 ? '… (truncated)' : ''}`;
    }
    if (item === null || typeof item === 'boolean') {
      return item;
    }
    if (typeof item === 'number') {
      return number(item) ?? '[unavailable]';
    }
    if (Array.isArray(item)) {
      return [
        ...item.slice(0, 50).map((child: unknown) => copy(child, depth + 1)),
        ...(item.length > 50 ? ['[truncated]'] : []),
      ];
    }
    if (record(item)) {
      const entries = Object.entries(item);
      return Object.fromEntries([
        ...entries
          .slice(0, 50)
          .map(([key, child]) => [text(key) ?? '', credentialKey(key) ? '[redacted]' : copy(child, depth + 1)]),
        ...(entries.length > 50 ? [['…', '[truncated]']] : []),
      ]);
    }
    return '[unavailable]';
  };
  return copy(value);
}
function model(value: unknown): string | undefined {
  if (!record(value)) {
    return undefined;
  }
  const provider = text(value.providerID);
  const id = text(value.modelID) ?? text(value.id);
  return provider === undefined || id === undefined ? undefined : `${provider}/${id}`;
}
function agentObservation(value: Record<string, unknown>): RunningAgent | undefined {
  const name = text(value.name);
  return name === undefined
    ? undefined
    : {
        name,
        model: model(value.model),
        variant: text(value.variant),
        temperature: number(value.temperature),
        topP: number(value.topP),
        ...(record(value.options) ? { options: safeOptions(value.options) } : {}),
      };
}
function messageObservation(value: unknown): MessageObservation | undefined {
  if (!record(value) || !record(value.info) || (value.info.role !== 'user' && value.info.role !== 'assistant')) {
    return undefined;
  }
  const info = value.info;
  const id = text(info.id);
  if (id === undefined) {
    return undefined;
  }
  const time = record(info.time) ? info.time : {};
  const completed = number(time.completed);
  return {
    id,
    agent: text(info.agent),
    created: number(time.created),
    completed,
    model: info.role === 'user' ? model(info.model) : model(info),
    variant: info.role === 'user' && record(info.model) ? text(info.model.variant) : text(info.variant),
    ...(info.role === 'assistant'
      ? { status: info.error !== undefined ? 'error' : completed === undefined ? 'incomplete' : 'completed' }
      : {}),
  };
}
function consistency(config: Record<string, unknown>) {
  return structuredClone({
    model: config.model,
    small_model: config.small_model,
    default_agent: config.default_agent,
    agent: config.agent,
    markerIds: Array.isArray(config.plugin)
      ? config.plugin.flatMap((entry: unknown) =>
          Array.isArray(entry) && record(entry[1]) && record(entry[1].__configComposerRuntime)
            ? [entry[1].__configComposerRuntime.id]
            : [],
        )
      : [],
  });
}
async function publicData(read: () => Promise<unknown>): Promise<unknown> {
  try {
    const response = await read();
    if (!record(response)) {
      return undefined;
    }
    const failed = Boolean(response.error);
    return failed ? undefined : response.data;
  } catch {
    return undefined;
  }
}

function runtimeLocation(api: TuiPluginApi, registrationRoot: string) {
  const path: { directory?: string; worktree?: string } = api.state.path;
  const directory = typeof path.directory === 'string' && path.directory !== '' ? path.directory : registrationRoot;
  const worktree = typeof path.worktree === 'string' && path.worktree !== '' ? path.worktree : undefined;
  return { root: worktree !== undefined && worktree !== '/' ? worktree : directory, directory };
}
function parameterObservation(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (record(value)) {
    for (const field of ['temperature', 'topP', 'topK', 'maxOutputTokens']) {
      const control = number(value[field]);
      if (control !== undefined) {
        result[field] = control;
      }
    }
    if (record(value.options)) {
      result.options = safeOptions(value.options);
    }
  }
  return result;
}

/** Read public observations only. Saved files and native TUI selection caches are outside this view. */
export async function readRunningInspection(api: TuiPluginApi, registrationRoot: string): Promise<RunningInspection> {
  const client = api.client;
  const location = runtimeLocation(api, registrationRoot);
  const route = api.route.current;
  const sessionID = route.name === 'session' ? text(route.params?.sessionID) : undefined;
  const config = await publicData(() => client.config.get({ directory: location.directory }));
  if (!record(config)) {
    throw new SettingsError('Running configuration is unavailable. Check the server connection and refresh.');
  }
  const initial = consistency(config);
  const inspection: RunningInspection = {
    observedAt: Date.now(),
    location,
    defaults: {
      model: text(config.model),
      small_model: text(config.small_model),
      default_agent: text(config.default_agent),
    },
    unavailable: {},
  };
  try {
    const applied = readRuntimeChoices(config, location, registrationRoot);
    inspection.composerId = applied.id;
    inspection.choices = Object.fromEntries(
      Object.entries(applied.choices).map(([name, choice]) => [
        name,
        {
          model: text(choice.model),
          variant: text(choice.variant),
          ...(choice.parameters === undefined
            ? {}
            : {
                parameters: parameterObservation(choice.parameters),
              }),
        },
      ]),
    );
  } catch (error) {
    inspection.unavailable.composer =
      error instanceof SettingsError
        ? error.message
        : 'Applied Composer parameters are unavailable. Restart the matching plugin and refresh.';
  }
  const [agents, session, history] = await Promise.all([
    publicData(() => client.app.agents({ directory: location.directory })),
    sessionID === undefined
      ? Promise.resolve(undefined)
      : publicData(() => client.session.get({ sessionID, directory: location.directory })),
    sessionID === undefined
      ? Promise.resolve(undefined)
      : publicData(() => client.session.messages({ sessionID, directory: location.directory })),
  ]);
  if (Array.isArray(agents) && agents.every(record)) {
    inspection.agents = agents.flatMap((item) => {
      const agent = agentObservation(item);
      return agent === undefined ? [] : [agent];
    });
    if (record(config.agent)) {
      for (const agent of inspection.agents) {
        const declared = config.agent[agent.name];
        if (
          record(declared) &&
          ((text(declared.model) !== undefined && text(declared.model) !== agent.model) ||
            (text(declared.variant) !== undefined && text(declared.variant) !== agent.variant))
        ) {
          throw new SettingsError(
            'Running agent settings changed or disagree with configuration. Refresh the inspector.',
          );
        }
      }
    }
  } else {
    inspection.unavailable.agents = 'Running agents are unavailable. Check the server connection and refresh.';
  }
  if (sessionID !== undefined) {
    inspection.conversation = { sessionID };
    if (record(session) && session.id === sessionID) {
      inspection.conversation.stored = {
        agent: text(session.agent),
        model: model(session.model),
        variant: record(session.model) ? text(session.model.variant) : undefined,
      };
    } else {
      inspection.unavailable.session =
        'Recorded session selection is unavailable. Check the server connection and refresh.';
    }
    if (Array.isArray(history)) {
      // Native history is chronological; reverse it so equal timestamps keep the newest record first.
      const sorted = history
        .filter(record)
        .toReversed()
        .sort((left, right) => {
          const at = (value: Record<string, unknown>) =>
            record(value.info) && record(value.info.time) ? (number(value.info.time.created) ?? 0) : 0;
          return at(right) - at(left);
        });
      const byRole = (role: string) =>
        sorted
          .filter((item) => record(item.info) && item.info.role === role)
          .flatMap((item) => {
            const observation = messageObservation(item);
            return observation === undefined ? [] : [observation];
          });
      inspection.conversation.latestRequest = byRole('user')[0];
      const responses = byRole('assistant');
      inspection.conversation.latestResponse = responses[0];
      inspection.conversation.lastCompletedResponse = responses.find((response) => response.status === 'completed');
    } else {
      inspection.unavailable.history =
        'Recorded message history is unavailable. Check the server connection and refresh.';
    }
  }
  const final = await publicData(() => client.config.get({ directory: location.directory }));
  if (
    !record(final) ||
    !isDeepStrictEqual(initial, consistency(final)) ||
    client !== api.client ||
    !isDeepStrictEqual(location, runtimeLocation(api, registrationRoot))
  ) {
    throw new SettingsError('Running configuration changed during inspection. Refresh to read one configuration.');
  }
  return inspection;
}

const valueLabel = (value: unknown): string => {
  const rendered =
    value === undefined ? 'OpenCode fallback / unset' : typeof value === 'string' ? value : JSON.stringify(value);
  return rendered.length > 1200 ? `${rendered.slice(0, 1200)}… (truncated)` : rendered;
};
function modelLines(value: ModelObservation): string {
  return `Agent: ${value.agent ?? 'unavailable'}\nModel: ${value.model ?? 'OpenCode fallback / unset'}\nVariant: ${value.variant ?? 'unset'}`;
}
function messageLines(value: MessageObservation | undefined, empty: string): string {
  if (value === undefined) {
    return empty;
  }
  return `${modelLines(value)}\nMessage: ${value.id}\nCreated: ${value.created === undefined ? 'unavailable' : new Date(value.created).toISOString()}${value.status === undefined ? '' : `\nStatus: ${value.status}`}${value.completed === undefined ? '' : `\nCompleted: ${new Date(value.completed).toISOString()}`}`;
}
const apiLimits =
  'Current native TUI model/variant selection is unavailable through the public plugin API.\n' +
  'Stored session fallback and recorded history do not predict the next request.\n' +
  'Final provider request parameters are unavailable through configuration and message APIs.\n' +
  'Configured model-bound Composer contributions apply only to their model. Native pins, selected variants and capability limits may take precedence.\n' +
  'Running values have no source-file attribution in this view. Inspection does not save, apply, select models or send prompts.';

export function openRunning(
  inspection: RunningInspection,
  navigation: ReturnType<typeof dialogNavigation>,
  refresh: () => void | Promise<void>,
): void {
  const alert = (title: string, message: string) => navigation.alert({ title, message });
  navigation.menu({
    title: 'Running configuration inspector',
    placeholder: 'Search fields…',
    options: [
      ...(['model', 'small_model', 'default_agent'] as const).map((field) => ({
        title: field,
        value: field,
        category: 'Running workspace defaults',
        description: valueLabel(inspection.defaults[field]),
      })),
      {
        title: 'Running agents',
        value: 'agents',
        description: inspection.unavailable.agents ?? `${inspection.agents?.length ?? 0} configured agents`,
      },
      {
        title: 'Applied Composer parameters',
        value: 'parameters',
        description: inspection.unavailable.composer ?? 'Configured model-bound contributions',
      },
      {
        title: 'Recorded conversation',
        value: 'conversation',
        description:
          inspection.conversation === undefined
            ? 'Open a conversation to inspect recorded selections'
            : inspection.conversation.sessionID,
      },
      {
        title: 'API limits',
        value: 'limits',
        description: 'Native TUI selection and final request parameters are unavailable',
      },
      { title: 'Refresh', value: 'refresh', description: 'Read current server observations again' },
    ],
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- The caller owns guarded asynchronous refresh failures and completion.
    onSelect: (option) => {
      if (option.value === 'refresh') {
        return refresh();
      }
      if (option.value === 'agents') {
        if (inspection.agents === undefined) {
          alert(option.title, inspection.unavailable.agents ?? 'Running agents are unavailable.');
        } else {
          navigation.menu({
            title: 'Running agents',
            options: inspection.agents.map((agent) => ({
              title: agent.name,
              value: agent.name,
              description: `${valueLabel(agent.model)}${agent.variant === undefined ? '' : ` (${agent.variant})`}`,
            })),
            onSelect: (selected) => {
              const agent = inspection.agents?.find((item) => item.name === selected.value);
              if (agent !== undefined) {
                alert(
                  `Running agent: ${agent.name}`,
                  `${modelLines({ ...agent, agent: agent.name })}\nTemperature: ${valueLabel(agent.temperature)}\ntopP: ${valueLabel(agent.topP)}\nOptions: ${valueLabel(agent.options)}\n\nConfigured running agent defaults; session selections and Composer dispatch contributions can change request settings.\nFinal provider request parameters are unavailable.`,
                );
              }
            },
          });
        }
      } else if (option.value === 'parameters') {
        if (inspection.choices === undefined) {
          alert(option.title, inspection.unavailable.composer ?? 'Applied Composer parameters are unavailable.');
        } else {
          navigation.menu({
            title: 'Applied Composer parameters',
            options: Object.entries(inspection.choices).map(([name, choice]) => ({
              title: name,
              value: name,
              description: valueLabel(choice.model),
            })),
            onSelect: (selected) => {
              const choice = inspection.choices?.[selected.value];
              if (choice !== undefined) {
                alert(
                  `Applied Composer parameters: ${selected.value}`,
                  `Model: ${valueLabel(choice.model)}\nVariant: ${choice.variant ?? 'unset'}\nParameters: ${valueLabel(choice.parameters)}\n\nConfigured model-bound Composer contributions; native pins, selected variants and capability limits may take precedence. Final provider request parameters are unavailable.`,
                );
              }
            },
          });
        }
      } else if (option.value === 'conversation') {
        const conversation = inspection.conversation;
        alert(
          option.title,
          conversation === undefined
            ? 'Open a conversation to inspect its recorded session fallback and history.\n\n' + apiLimits
            : `Conversation: ${conversation.sessionID}\n\nStored session fallback\n${conversation.stored === undefined ? (inspection.unavailable.session ?? 'Unavailable') : modelLines(conversation.stored)}\n\nLatest recorded request\n${messageLines(conversation.latestRequest, inspection.unavailable.history ?? 'No recorded requests')}\n\nLatest recorded response\n${messageLines(conversation.latestResponse, inspection.unavailable.history ?? 'No assistant responses')}${conversation.lastCompletedResponse !== undefined && conversation.lastCompletedResponse.id !== conversation.latestResponse?.id ? `\n\nLast completed response\n${messageLines(conversation.lastCompletedResponse, 'No completed responses')}` : ''}\n\nRecorded selections can differ from current configuration and the next request. Current native TUI model/variant selection is unavailable through the public plugin API. Final provider request parameters are unavailable.`,
        );
      } else if (option.value === 'limits') {
        alert(option.title, apiLimits);
      } else {
        const field =
          option.value === 'model' || option.value === 'small_model' || option.value === 'default_agent'
            ? option.value
            : undefined;
        if (field !== undefined) {
          alert(
            option.title,
            `${valueLabel(inspection.defaults[field])}\n\nRunning workspace default from the server. Source file unavailable; session selections can override configured defaults.`,
          );
        }
      }
    },
  });
}
