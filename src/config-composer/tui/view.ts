import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import type { dialogNavigation } from '../../tui/navigation.ts';
import type { AttestedRuntime } from '../composition/runtime-baseline.ts';
import type { ConfigurationContext } from '../storage.ts';
import type { CatalogModel } from '../settings.ts';
import type { FieldDecision, Selection } from '../composition/document-types.ts';
export interface ConfigurationView {
  api: TuiPluginApi;
  nav: ReturnType<typeof dialogNavigation>;
  context: ConfigurationContext;
  run(action: () => void | Promise<void>): void;
  catalog(): Promise<CatalogModel[]>;
  choose(choice: Selection): Promise<void>;
  details(title: string, text: string): void;
}
export const permissionNotice =
  'Agent-level permission contribution. Global and built-in inheritance remains host-owned.\nOmitted rules do not mean no enforcement.';
export function fieldDetail(
  view: { context: { runtime: AttestedRuntime; source: { path: string } } },
  key: string,
  decision: FieldDecision | undefined,
): string {
  if (decision === undefined) {
    return 'No authored value at this level. Native inheritance remains host-owned.';
  }
  const [, kind = '', escapedName = '', escapedField = kind] = key.split('/');
  const decode = (value: string) => value.replaceAll('~1', '/').replaceAll('~0', '~');
  const field = decode(escapedField);
  const name = decode(escapedName);
  const raw =
    kind === 'agent'
      ? Object.entries(
          Object.hasOwn(view.context.runtime.observation.authority, name)
            ? view.context.runtime.observation.authority[name].fields
            : {},
        ).find(([key]) => key === field)?.[1]
      : undefined;
  const origin = (value: FieldDecision['origin']) => {
    const source =
      value.kind === 'native'
        ? 'Native supplied configuration'
        : `${value.source ?? view.context.source.path} · ${value.pointer ?? field}`;
    return value.modelBinding === undefined
      ? source
      : `${source}\nModel alias ${JSON.stringify(value.modelBinding.name)} binding: ${view.context.source.path} · ${value.modelBinding.pointer}`;
  };
  return [
    `${field}: ${JSON.stringify(decision.value)}`,
    field === 'variant' && decision.value === '' && decision.origin.modelBinding !== undefined
      ? 'Native default variant (the model binding supplies no named variant).'
      : '',
    decision.origin.kind === 'frontmatter'
      ? `Pinned by frontmatter\n${origin(decision.origin)}\nRaw authored fields: ${JSON.stringify(raw?.authored)}`
      : origin(decision.origin),
    decision.blockedComposer === undefined
      ? ''
      : `Blocked Composer value: ${JSON.stringify(decision.blockedComposer.value)}\n${origin(decision.blockedComposer.origin)}`,
    field === 'permission' ? permissionNotice : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
