import { type AgentSettings, SettingsError, agentGroups } from '../settings.ts';
import type { ComponentGroup } from './document-types.ts';

/** A structurally valid composition whose active membership can be repaired through scoped editing. */
export class MembershipValidationError extends SettingsError {
  readonly group: string;
  readonly member?: string;
  readonly kind: 'agents' | 'skills' | 'commands' | 'prompts';
  constructor(message: string, group: string, member?: string, kind: MembershipValidationError['kind'] = 'agents') {
    super(`${message} Open /compose → Repair invalid memberships to review saved sources.`);
    this.group = group;
    this.member = member;
    this.kind = kind;
  }
}

/** Resolve a selected group's members against a complete host/custom agent registry. Never synthesize agents. */
export function resolveGroupAgentNames(
  group: string,
  groups: Record<string, ComponentGroup>,
  available: Record<string, AgentSettings>,
): string[] {
  if (!Object.hasOwn(groups, group)) {
    throw new MembershipValidationError(
      `Component group ${group} does not exist. Define it before selecting it.`,
      group,
    );
  }
  const members = new Set<string>();
  for (const name of groups[group].agents ?? []) {
    if (!Object.hasOwn(available, name)) {
      throw new MembershipValidationError(
        `Agent ${name} is unavailable. Use an available native or custom agent name in ${group}.`,
        group,
        name,
      );
    }
    if (available[name].disable === true) {
      throw new MembershipValidationError(
        `Agent ${name} is disabled. Remove it from ${group} or enable it explicitly.`,
        group,
        name,
      );
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
        throw new MembershipValidationError(
          `Agent ${name} names unknown component group ${membership}. Define it or correct the frontmatter groups.`,
          membership,
          name,
        );
      }
    }
    if (memberships.includes(group)) {
      members.add(name);
    }
  }
  return [...members];
}
