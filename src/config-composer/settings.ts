export class SettingsError extends Error {}

/** A known native cache limitation that scoped instance reload cannot resolve. */
export class RestartRequiredError extends SettingsError {}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  variants: Record<string, Record<string, unknown>>;
}

export function catalogModels(providers: unknown): CatalogModel[] {
  if (!Array.isArray(providers)) {
    throw new SettingsError('The provider model list is unavailable. Try again.');
  }
  return providers
    .flatMap((provider) => {
      if (!record(provider) || typeof provider.id !== 'string' || !record(provider.models)) {
        return [];
      }
      const providerID = provider.id;
      const providerName = typeof provider.name === 'string' ? provider.name : providerID;
      return Object.entries(provider.models).flatMap(([id, model]) => {
        if (!record(model) || model.status === 'deprecated') {
          return [];
        }
        const variants = record(model.variants)
          ? Object.fromEntries(
              Object.entries(model.variants).filter(
                (entry): entry is [string, Record<string, unknown>] => record(entry[1]) && entry[1].disabled !== true,
              ),
            )
          : {};
        return [
          {
            id: `${providerID}/${id}`,
            name: typeof model.name === 'string' ? model.name : id,
            provider: providerName,
            variants,
          },
        ];
      });
    })
    .sort((a, b) => {
      const providerOrder = a.provider.localeCompare(b.provider);
      return providerOrder !== 0 ? providerOrder : a.name.localeCompare(b.name);
    });
}

export function validateChoice(
  choice: { model?: string; variant?: string },
  models: CatalogModel[],
): CatalogModel | undefined {
  if (typeof choice.model !== 'string' || choice.model === '') {
    return undefined;
  }
  const model = models.find((item) => item.id === choice.model);
  if (model === undefined) {
    throw new SettingsError('That model is no longer available from the configured providers. Refresh the list.');
  }
  if (typeof choice.variant === 'string' && choice.variant !== '' && !Object.hasOwn(model.variants, choice.variant)) {
    throw new SettingsError('That variant is not available for the selected model.');
  }
  return model;
}
