import type { Snapshot, previewFilePlan } from '../storage.ts';
import { type CatalogModel, type ModelChoice, SettingsError, record, validateChoice } from '../settings.ts';
import { resolveConfigurationSettings } from './runtime.ts';
import { type ModelParameters, filterParameters, parameterMetadata, parseParameters } from './parameters.ts';
import { type ConfigurationTarget, valueAt } from './parameter-authoring.ts';

export function validateParameterChoice(
  choice: ModelChoice & { parameters?: ModelParameters },
  catalog: CatalogModel[],
) {
  const model = validateChoice(choice, catalog);
  if (model === undefined || choice.parameters === undefined) {
    return model;
  }
  const filtered = filterParameters(choice.parameters, model.parameterMetadata);
  const unsupported = Object.keys(choice.parameters).filter((key) => !Object.hasOwn(filtered, key));
  if (unsupported.length > 0) {
    throw new SettingsError(
      `${model.id} does not support ${unsupported.join(', ')} in the tested adapter/catalog. Remove those local controls before saving.`,
    );
  }
  return model;
}

type Preview = Awaited<ReturnType<typeof previewFilePlan>>;
export function parameterReview(
  snapshot: Snapshot,
  target: ConfigurationTarget,
  preview: Preview,
  catalog: CatalogModel[],
): string {
  const checks: { label: string; choice: ModelChoice; parameters: ModelParameters }[] = Object.entries(
    preview.resolved.choices,
  )
    .filter(([name, choice]) => JSON.stringify(choice) !== JSON.stringify(snapshot.resolved.choices[name]))
    .map(([name, choice]) => ({ label: name, choice: choice, parameters: choice.parameters ?? {} }));
  const source = preview.sources.documents.find((source) => source.id === target.sourceId);
  const changed = checks.map(({ label }) => label);
  const configuration = valueAt(source?.value, target.path);
  let deferred = false;
  if (record(configuration)) {
    let reference: unknown = configuration.modelRef;
    const seen = new Set<string>();
    while (typeof reference === 'string' && reference.startsWith('preset:') && !seen.has(reference)) {
      seen.add(reference);
      reference = preview.sources.registry.configurationPresets?.[reference.slice(7)]?.modelRef;
    }
    deferred =
      target.path[0] === 'profiles' &&
      !preview.sources.orderedProfiles.some((profile) => profile.name === target.path[1]) &&
      typeof reference === 'string' &&
      reference.startsWith('opencode:');
  }
  if (record(configuration) && !deferred) {
    const resolved = resolveConfigurationSettings(
      configuration,
      {
        sourceId: target.sourceId,
        pointer: `/${target.path.map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`,
        layer: 'parameter target',
        operation: 'set',
        references: [],
        overwritten: [],
      },
      {
        presets: preview.sources.registry.configurationPresets ?? {},
        globals: { model: preview.resolved.model, small_model: preview.resolved.small_model },
        provenance: { ...preview.sources.provenance, ...preview.resolved.provenance },
      },
    ).value;
    checks.push({ label: target.label, choice: resolved, parameters: parseParameters(resolved.parameters ?? {}) });
  }
  const lines = new Set<string>([
    changed.length === 0
      ? 'No effective active agent parameters change. This target may be inactive or masked by later contributions or native pins.'
      : `Active agent parameter previews: ${changed.join(', ')}.`,
    ...(deferred
      ? [
          `${target.label}: structurally valid; this inactive profile has a context-dependent native model reference. Model support is checked when the profile is activated.`,
        ]
      : []),
  ]);
  for (const { label, choice, parameters } of checks) {
    const text = JSON.stringify(parameters);
    lines.add(`${label}: resolved parameters ${text.slice(0, 1200)}${text.length > 1200 ? '… (truncated)' : ''}.`);
    const model = validateParameterChoice({ ...choice, parameters }, catalog);
    if (model === undefined) {
      lines.add(`${label}: structurally valid; model-dependent support will be checked at dispatch.`);
      continue;
    }
    const metadata = parameterMetadata(model.parameterMetadata, parameters);
    lines.add(
      `${label}: ${model.id}; ${metadata.adapter === undefined ? 'custom options are provider-unverified' : `${metadata.adapter.package} ${metadata.adapter.version}; reasoningEffort requires a string; other custom options remain provider-unverified`}.`,
    );
  }
  return [...lines].join('\n');
}
