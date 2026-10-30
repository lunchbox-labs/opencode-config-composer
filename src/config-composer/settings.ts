export class SettingsError extends Error {}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CatalogModel {
  id: string;
  /** The provider adapter package serving this model, when the catalog reports one. */
  npm?: string;
  variants: Record<string, Record<string, unknown>>;
}

export function catalogModels(providers: unknown): CatalogModel[] {
  if (!Array.isArray(providers)) {
    throw new SettingsError('The provider model list is unavailable. Try again.');
  }
  return providers.flatMap((provider) => {
    if (!record(provider) || typeof provider.id !== 'string' || !record(provider.models)) {
      return [];
    }
    const providerID = provider.id;
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
      const npm = record(model.api) && typeof model.api.npm === 'string' ? model.api.npm : undefined;
      return [
        {
          id: `${providerID}/${id}`,
          ...(npm === undefined ? {} : { npm }),
          variants,
        },
      ];
    });
  });
}

export function validateChoice(choice: { model?: string; variant?: string }, models: CatalogModel[]): void {
  if (typeof choice.model !== 'string' || choice.model === '') {
    return;
  }
  const model = models.find((item) => item.id === choice.model);
  if (model === undefined) {
    throw new SettingsError('That model is no longer available from the configured providers. Refresh the list.');
  }
  if (typeof choice.variant === 'string' && choice.variant !== '' && !Object.hasOwn(model.variants, choice.variant)) {
    throw new SettingsError('That variant is not available for the selected model.');
  }
}
