import type { dialogNavigation } from '../../tui/navigation.ts';
import type { Snapshot } from '../storage.ts';
import { record } from '../settings.ts';
import type { FieldOrigin } from '../composition/types.ts';

function savedValue(snapshot: Snapshot, pointer: string): unknown {
  const parts = pointer
    .slice(1)
    .split('/')
    .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));
  let value: unknown = snapshot.resolved;
  if (parts[0] === 'agent' && parts[2] === 'parameters') {
    value = Object.hasOwn(snapshot.resolved.choices, parts[1])
      ? snapshot.resolved.choices[parts[1]].parameters
      : undefined;
    parts.splice(0, 3);
  }
  for (const key of parts) {
    if ((!record(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = Reflect.get(value, key);
  }
  return value;
}

const valueLabel = (value: unknown): string => {
  const text =
    value === undefined ? 'OpenCode fallback / unset' : typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 1200 ? `${text.slice(0, 1200)}… (truncated)` : text;
};

/** Saved composition provenance is inspectable; it is not an applied host revision. */
export function openEffective(snapshot: Snapshot, navigation: ReturnType<typeof dialogNavigation>): void {
  const describe = (origin: FieldOrigin, depth = 0): string => {
    const label = origin.sourceId ?? 'Native input · source unavailable';
    return [
      `${label}\n${origin.pointer}\n${origin.layer} · ${origin.operation}`,
      ...(origin.references.length === 0 ? [] : [`References: ${origin.references.join(', ')}`]),
      ...(depth < 32 ? origin.overwritten.map((previous) => `Overwritten: ${describe(previous, depth + 1)}`) : []),
    ].join('\n');
  };
  const authoredModels = Object.entries(snapshot.resolved.agent).flatMap(([name, agent]) =>
    ['model', 'variant'].flatMap((field) =>
      typeof agent[field] === 'string' ? [`/agent/${name.replaceAll('~', '~0').replaceAll('/', '~1')}/${field}`] : [],
    ),
  );
  const pointers = [
    ...new Set(['/model', '/small_model', ...authoredModels, ...Object.keys(snapshot.resolved.provenance)]),
  ];
  navigation.menu({
    title: 'Saved composition preview',
    placeholder: 'Search fields…',
    options: [
      {
        title: 'Profiles and layer order',
        value: '+profiles',
        category: 'Selection',
        description:
          snapshot.sources.activeProfiles.length === 0
            ? 'No active profiles'
            : snapshot.sources.activeProfiles.join(' → '),
      },
      ...pointers.map((pointer) => ({
        title: pointer,
        value: pointer,
        category: 'Resolved saved fields',
        description: valueLabel(savedValue(snapshot, pointer)),
      })),
      { title: 'Source files and editability', value: '+sources', category: 'Sources' },
      ...(snapshot.resolved.permissions.length === 0
        ? []
        : [
            {
              title: 'Ordered permission contributions',
              value: '+permissions',
              category: 'Permissions',
              description: 'Authored contributions; enforcement integration is pending',
            },
          ]),
    ],
    onSelect: (option) => {
      let message: string;
      if (option.value === '+profiles') {
        message =
          `Selection is project-wide.\nActive profiles: ${snapshot.sources.activeProfiles.length === 0 ? 'none' : snapshot.sources.activeProfiles.join(' → ')}\n\n` +
          `Replayed profile order: ${snapshot.sources.orderedProfiles.length === 0 ? 'none' : snapshot.sources.orderedProfiles.map((item) => item.name).join(' → ')}\n\n` +
          snapshot.sources.scopes
            .map(
              (source) =>
                `${source.path}: ${source.value.activeProfiles === undefined ? 'inherit selection' : JSON.stringify(source.value.activeProfiles)}`,
            )
            .join('\n') +
          '\n\nAn absent selection inherits; [] selects none. Later profile layers run after earlier layers. Existing conversations are retained.';
      } else if (option.value === '+sources') {
        message =
          snapshot.files
            .map((file) => `${file.path}\n${file.writable === false ? 'Read-only' : 'Writable'} in this editor`)
            .join('\n\n') +
          '\n\nSaved preview: the running configuration may differ until reload. Session model selections can still override configured defaults.';
      } else if (option.value === '+permissions') {
        message =
          snapshot.resolved.permissions
            .map(
              (item, index) =>
                `${index + 1}. ${item.agent}: ${item.rule.tool} ${item.rule.pattern ?? '*'} → ${item.rule.action}\n${describe(item.origin)}`,
            )
            .join('\n\n') +
          '\n\nThese are ordered Composer contributions. Native permission compilation and failure handling are not integrated.';
      } else {
        const origin: FieldOrigin | undefined = Object.hasOwn(snapshot.resolved.provenance, option.value)
          ? snapshot.resolved.provenance[option.value]
          : undefined;
        message =
          `Saved preview: ${valueLabel(savedValue(snapshot, option.value))}\n\n` +
          (origin === undefined ? 'Native or component source value · origin unavailable' : describe(origin));
      }
      navigation.alert({ title: option.title, message });
    },
  });
}
