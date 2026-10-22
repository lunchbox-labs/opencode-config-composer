import { SettingsError, record } from './settings.ts';

/** Native agent metadata, never a provider option or a Composer settings patch. */
export function readAgentGroups(value: unknown, source: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string' && item.trim() !== '' && !item.includes('\0')) ||
    new Set(value).size !== value.length
  ) {
    throw new SettingsError(`${source}: groups must be an array of unique nonempty names.`);
  }
  return [...value];
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
