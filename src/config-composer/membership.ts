import { record } from './settings.ts';

function groupName(item: unknown): item is string {
  return typeof item === 'string' && item.trim() !== '' && !item.includes('\0');
}

/** True only for the normalized form readAgentGroups returns. */
export function normalizedGroups(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(groupName) && new Set(value).size === value.length;
}

/**
 * Native agent metadata, never a provider option or a Composer settings patch. A bare name becomes a
 * one-item list; invalid and repeated entries are dropped, keeping the first occurrence.
 */
export function readAgentGroups(value: unknown, source: string, warnings?: string[]): string[] {
  if (normalizedGroups(value)) {
    return [...value];
  }
  const listed: unknown[] = Array.isArray(value) ? value : [value];
  const groups = [...new Set(listed.filter(groupName))];
  warnings?.push(`${source}: groups normalized to ${JSON.stringify(groups)}.`);
  return groups;
}

export function withoutGroups(options: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'groups'));
}

/** OpenCode retains unknown agent keys and also copies them into options. */
export function nativeAgentSettings(agent: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(agent)
      .filter(([key]) => key !== 'groups')
      .map(([key, value]) => [key, key === 'options' && record(value) ? withoutGroups(value) : value]),
  );
}
