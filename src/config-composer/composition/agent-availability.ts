import { type AgentSettings, SettingsError } from '../settings.ts';
import { CompositionValidationError } from './document.ts';
import type { LoadedSources } from './sources.ts';
import type { FieldOrigin } from './types.ts';

export const internalAgents = new Set(['title', 'summary', 'compaction']);
const builtinModes: Record<string, string> = {
  build: 'primary',
  plan: 'primary',
  general: 'subagent',
  explore: 'subagent',
  title: 'primary',
  summary: 'primary',
  compaction: 'primary',
};
export interface AgentAvailability {
  enabled: boolean;
  status: 'enabled' | 'hidden' | 'disabled' | 'unselected';
  hidden: boolean;
  mode: string;
  internal: boolean;
  origin?: FieldOrigin;
}
const part = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');

/** Validate all declared targets, including inactive profiles, without activating definitions. */
export function availabilityTargets(sources: LoadedSources, available: Record<string, AgentSettings>): Set<string> {
  for (const [profile, definition] of Object.entries(sources.registry.profiles ?? {})) {
    for (const name of Object.keys(definition.agentAvailability ?? {})) {
      if (internalAgents.has(name) || !Object.hasOwn(available, name)) {
        const pointer = `/profiles/${part(profile)}/agentAvailability/${part(name)}`;
        throw new CompositionValidationError({
          code: 'invalid-agent-availability',
          sourceId: sources.provenance[`/profiles/${part(profile)}`].sourceId,
          pointer,
          message: internalAgents.has(name)
            ? `Agent ${name} is internal to OpenCode and cannot be toggled by a workflow profile.`
            : `Agent ${name} is unavailable. Use an existing native or declared component agent.`,
        });
      }
    }
  }
  return new Set(sources.orderedProfiles.flatMap(({ profile }) => Object.keys(profile.agentAvailability ?? {})));
}

export function inspectAvailability(
  available: Record<string, AgentSettings>,
  composed: Record<string, AgentSettings>,
  componentNames: Set<string>,
  selected: Set<string>,
  provenance: Record<string, FieldOrigin>,
): Record<string, AgentAvailability> {
  return Object.fromEntries(
    Object.entries(available).map(([name, native]) => {
      const value = Object.hasOwn(composed, name) ? composed[name] : native;
      const hidden = typeof value.hidden === 'boolean' ? value.hidden : internalAgents.has(name);
      const unselected = componentNames.has(name) && !selected.has(name);
      return [
        name,
        {
          enabled: value.disable !== true && (!componentNames.has(name) || selected.has(name)),
          status: value.disable === true ? 'disabled' : unselected ? 'unselected' : hidden ? 'hidden' : 'enabled',
          hidden,
          mode:
            typeof value.mode === 'string'
              ? value.mode
              : Object.hasOwn(builtinModes, name)
                ? builtinModes[name]
                : 'all',
          internal: internalAgents.has(name),
          origin: provenance[`/agent/${part(name)}/disable`],
        },
      ];
    }),
  );
}

export function validateAvailablePrimary(agents: Record<string, AgentAvailability>, defaultAgent?: string): void {
  const primary = (agent?: AgentAvailability) => agent?.enabled === true && !agent.hidden && agent.mode !== 'subagent';
  if (!Object.values(agents).some(primary)) {
    throw new SettingsError(
      'Profile availability must retain at least one enabled visible primary agent. Enable build, plan, or a visible custom primary agent.',
    );
  }
  if (defaultAgent !== undefined && defaultAgent !== '' && !primary(agents[defaultAgent])) {
    throw new SettingsError(
      `Native default_agent ${defaultAgent} must remain enabled, visible and primary. Enable it or change the native default and restart before applying this selection.`,
    );
  }
}
