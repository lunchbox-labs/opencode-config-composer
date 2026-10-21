import type { SourceSnapshot } from '../storage.ts';
import type { DefinitionRegistry } from '../composition/authoring.ts';

/** Keep choice metadata next to the declaring source, never the inherited definition. */
export function definitionDescription(snapshot: SourceSnapshot, registry: DefinitionRegistry, name: string): string {
  const description =
    registry === 'configurationPresets' ? undefined : snapshot.sources.registry[registry]?.[name]?.description;
  const source = snapshot.sources.provenance[`/${registry}/${name}`].sourceId;
  return [description, source].filter((value) => value !== undefined && value !== '').join(' · ');
}
