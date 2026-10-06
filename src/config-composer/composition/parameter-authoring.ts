import { type FilePlan, type Snapshot, editJson } from '../storage.ts';
import { definitionDestinations } from './authoring.ts';
import { type ModelParameters, parseCustomOptions, parseParameters } from './parameters.ts';
import { SettingsError, record } from '../settings.ts';

export type ParameterField = keyof ModelParameters | 'reset';
export interface ConfigurationTarget {
  sourceId: string;
  path: string[];
  label: string;
}
export function valueAt(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (value, key) => (record(value) && Object.hasOwn(value, key) ? value[key] : undefined),
    value,
  );
}
export function configurationTargets(snapshot: Snapshot, sourceId: string): ConfigurationTarget[] {
  if (!definitionDestinations(snapshot).some((file) => file.path === sourceId)) {
    return [];
  }
  const source = snapshot.sources.documents.find((source) => source.id === sourceId);
  if (source === undefined) {
    throw new SettingsError('The parameter source is unavailable. Reopen the editor.');
  }
  const targets: ConfigurationTarget[] = [];
  const add = (label: string, path: string[]) => targets.push({ sourceId, path, label });
  const scoped = snapshot.sources.scopes.some((scope) => scope.id === sourceId);
  if (scoped) {
    add('Agent defaults', ['defaults', 'agents']);
  }
  for (const name of Object.keys(source.value.componentGroups ?? {})) {
    add(`Group: ${name}`, ['componentGroups', name, 'configuration']);
  }
  for (const name of Object.keys(source.value.configurationPresets ?? {})) {
    add(`Preset: ${name}`, ['configurationPresets', name]);
  }
  for (const name of Object.keys(source.value.components?.agents ?? {})) {
    add(`Component definition: ${name}`, ['components', 'agents', name, 'configuration']);
  }
  const agents = [
    ...new Set([...snapshot.agents.map((agent) => agent.name), ...Object.keys(source.value.overrides?.agents ?? {})]),
  ];
  for (const name of scoped ? agents : []) {
    add(`Agent override: ${name}`, ['overrides', 'agents', name]);
  }
  for (const [profile, value] of Object.entries(source.value.profiles ?? {})) {
    for (const name of new Set([...agents, ...Object.keys(value.overrides?.agents ?? {})])) {
      add(`Profile ${profile}: ${name} override`, ['profiles', profile, 'overrides', 'agents', name]);
    }
  }
  return targets;
}
export function parameterValue(snapshot: Snapshot, target: ConfigurationTarget): ModelParameters {
  const source = snapshot.sources.documents.find((source) => source.id === target.sourceId);
  return parseParameters(valueAt(source?.value, [...target.path, 'parameters']) ?? {});
}
export function planParameter(
  snapshot: Snapshot,
  target: ConfigurationTarget,
  field: ParameterField,
  text: string,
): FilePlan {
  const selected = configurationTargets(snapshot, target.sourceId).find(
    (item) => JSON.stringify(item.path) === JSON.stringify(target.path),
  );
  const file = definitionDestinations(snapshot).find((file) => file.path === target.sourceId);
  if (selected === undefined || file === undefined) {
    throw new SettingsError('Choose an available writable parameter destination and target.');
  }
  let value: unknown;
  if (field !== 'reset' && text.trim() !== '') {
    value = field === 'options' ? parseCustomOptions(text) : Number(text);
    parseParameters({ [field]: value });
  }
  const path = [...target.path, 'parameters', ...(field === 'reset' ? [] : [field])];
  const next = editJson(file.text, path, value);
  return {
    snapshot,
    edits: next === file.text ? [] : [{ file, text: next }],
    description: `${selected.label}: ${value === undefined ? 'remove local' : 'set'} ${field === 'reset' ? 'parameters; inherit earlier values' : field}${value === undefined ? '' : ` = ${JSON.stringify(value).slice(0, 1200)}${JSON.stringify(value).length > 1200 ? '… (truncated)' : ''}`} in ${file.path}`,
  };
}
