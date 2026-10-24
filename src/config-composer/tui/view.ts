import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import type { dialogNavigation } from '../../tui/navigation.ts';
import type { AttestedRuntime } from '../composition/runtime-baseline.ts';
import type { ConfigurationContext } from '../storage.ts';
import type { CatalogModel } from '../settings.ts';
import type { FieldDecision, NativeAuthority, ResolvedCandidate, Selection } from '../composition/document-types.ts';
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
  'Agent-level permission contribution. Native fallback is included when composing permissions; built-in inheritance remains host-owned.\nLater layers move touched tool blocks last, including retained patterns. Within a tool, later matching patterns win.';
export function modelParameterDetail(
  candidate: ResolvedCandidate,
  authority: NativeAuthority,
  name: string,
  source: string,
): string {
  const bindings = candidate.modelParameters;
  const binding = Object.hasOwn(bindings ?? {}, name) ? bindings?.[name] : undefined;
  if (binding === undefined) {
    return 'No model-bound parameter defaults.';
  }
  const fields = Object.hasOwn(authority, name) ? authority[name].fields : {};
  const agent = candidate.agent[name] ?? {};
  return [
    `Request defaults for ${binding.model} only:\n${JSON.stringify(binding.parameters, null, 2)}`,
    `Reference: ${source} · ${binding.origin.pointer ?? ''}\nBinding: ${source} · ${binding.origin.modelBinding?.pointer ?? ''}`,
    ...(['temperature', 'top_p'] as const)
      .filter((field) => Object.hasOwn(agent, field))
      .map(
        (field) =>
          `Explicit agent ${field}: ${JSON.stringify(agent[field])} takes priority${Object.hasOwn(fields, field) ? ' (frontmatter)' : ''}.`,
      ),
    Object.hasOwn(fields, 'options')
      ? `Alias options blocked by authored frontmatter: ${JSON.stringify(fields.options?.value)}`
      : 'Explicit agent and selected native variant options take priority over alias option defaults.',
    'These defaults apply only when the actual request uses the bound model. Native session choices may differ.',
  ].join('\n\n');
}
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
      ? `${field === 'permission' ? 'Frontmatter permission rules applied last' : 'Pinned by frontmatter'}\n${origin(decision.origin)}\nRaw authored fields: ${JSON.stringify(raw?.authored)}`
      : origin(decision.origin),
    field === 'permission' && raw !== undefined && decision.origin.kind !== 'frontmatter'
      ? `Authored frontmatter permission has no rules; inherited contributions remain.\n${raw.source.path}\nRaw authored fields: ${JSON.stringify(raw.authored)}`
      : '',
    decision.blockedComposer === undefined
      ? ''
      : `${field === 'permission' ? 'Composer contribution before frontmatter' : 'Blocked Composer value'}: ${JSON.stringify(decision.blockedComposer.value)}\n${origin(decision.blockedComposer.origin)}`,
    field === 'permission' ? permissionNotice : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
