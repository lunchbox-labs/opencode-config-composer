import { isDeepStrictEqual } from 'node:util';
import { type AgentSettings, SettingsError, agentGroups, record } from '../settings.ts';

export function nativeAgentProjection(agents: Record<string, AgentSettings>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      {
        model: agent.model ?? null,
        variant: agent.variant ?? null,
        prompt: agent.prompt ?? null,
        disable: agent.disable ?? false,
        groups: agentGroups(agent),
      },
    ]),
  );
}

/** A shared filesystem does not imply matching environment or additional native config inputs. */
export function verifyNativeAgents(local: Record<string, AgentSettings>, server: Record<string, AgentSettings>): void {
  if (!isDeepStrictEqual(nativeAgentProjection(local), nativeAgentProjection(server))) {
    throw new SettingsError(
      'Native agent inputs differ between this editor and the server. Use the same environment and native configuration sources, restart the server, and reopen the editor.',
    );
  }
}

/** Apply only source edits to the validated authoritative baseline, preserving other native fields. */
export function editNativeBaseline(
  baseline: Record<string, AgentSettings>,
  before: Record<string, AgentSettings>,
  after: Record<string, AgentSettings>,
): Record<string, AgentSettings> {
  const patch = (target: Record<string, unknown>, old: Record<string, unknown>, next: Record<string, unknown>) => {
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (isDeepStrictEqual(old[key], next[key])) {
        continue;
      }
      if (!Object.hasOwn(next, key)) {
        Reflect.deleteProperty(target, key);
      } else if (record(old[key]) && record(next[key]) && record(target[key])) {
        patch(target[key], old[key], next[key]);
      } else {
        target[key] = structuredClone(next[key]);
      }
    }
  };
  const result = structuredClone(baseline);
  patch(result, before, after);
  for (const [name, agent] of Object.entries(after)) {
    if (!isDeepStrictEqual(agentGroups(before[name] ?? {}), agentGroups(agent))) {
      result[name].groups = agentGroups(agent);
      if (record(result[name].options)) {
        Reflect.deleteProperty(result[name].options, 'groups');
      }
    }
  }
  return result;
}
