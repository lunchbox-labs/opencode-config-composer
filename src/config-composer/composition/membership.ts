import { type AgentSettings, SettingsError, agentGroups } from '../settings.ts';
import type { ComponentGroup } from './document-types.ts';

/** Resolve a selected group's members against a complete host/custom agent registry. Never synthesize agents. */
export function resolveGroupAgentNames(
  group: string,
  groups: Record<string, ComponentGroup>,
  available: Record<string, AgentSettings>,
): string[] {
  if (!Object.hasOwn(groups, group)) {
    throw new SettingsError(`Component group ${group} does not exist. Define it before selecting it.`);
  }
  const members = new Set<string>();
  for (const name of groups[group].agents ?? []) {
    if (!Object.hasOwn(available, name)) {
      throw new SettingsError(
        `Agent ${name} is unavailable. Use an available native or custom agent name in ${group}.`,
      );
    }
    if (available[name].disable === true) {
      throw new SettingsError(`Agent ${name} is disabled. Remove it from ${group} or enable it explicitly.`);
    }
    members.add(name);
  }
  // Native registry enumeration must not influence membership output. JSONC members retain authored order.
  for (const name of Object.keys(available).sort()) {
    const agent = available[name];
    if (agent.disable === true) {
      continue;
    }
    const memberships = agentGroups(agent);
    for (const membership of memberships) {
      if (!Object.hasOwn(groups, membership)) {
        throw new SettingsError(
          `Agent ${name} names unknown component group ${membership}. Define it or correct the frontmatter groups.`,
        );
      }
    }
    if (memberships.includes(group)) {
      members.add(name);
    }
  }
  return [...members];
}
