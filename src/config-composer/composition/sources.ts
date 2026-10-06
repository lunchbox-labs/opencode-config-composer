import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { configurationDirectory, configurationFile, configurationPath } from '../configuration.ts';
import { record } from '../settings.ts';
import { CompositionValidationError, parseCompositionDocument } from './document.ts';
import type {
  Components,
  CompositionDocument,
  CompositionProfile,
  CompositionSourceDocument,
  FieldOrigin,
} from './types.ts';

export interface ProjectContext {
  root: string;
  baseFile?: string;
  baseExplicit: boolean;
}

export interface ProfileOccurrence {
  name: string;
  profile: CompositionProfile;
  origin: FieldOrigin;
}

export interface LoadedSources {
  documents: CompositionSourceDocument[];
  scopes: CompositionSourceDocument[];
  registry: CompositionDocument;
  provenance: Record<string, FieldOrigin>;
  activeProfiles: string[];
  orderedProfiles: ProfileOccurrence[];
}

type Registry = Required<
  Pick<CompositionDocument, 'sourceDirectories' | 'componentGroups' | 'configurationPresets' | 'profiles'>
> & { components: Required<Components> };

function pointerPart(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

function fail(message: string, sourceId?: string, pointer = ''): never {
  throw new CompositionValidationError({ code: 'invalid-composition-source', message, sourceId, pointer });
}

function freeze(value: unknown): void {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

function relativeFile<T extends { file?: string }>(value: T, path: string): T {
  return value.file === undefined ? value : { ...value, file: configurationPath(value.file, dirname(path)) };
}

export async function loadCompositionSources(context: ProjectContext): Promise<LoadedSources> {
  const documents = new Map<string, CompositionSourceDocument>();
  const visited = new Set<string>();
  const scopes: CompositionSourceDocument[] = [];
  const provenance: Record<string, FieldOrigin> = {};
  const registry: Registry = {
    sourceDirectories: {},
    components: { agents: {}, skills: {}, commands: {}, prompts: {} },
    componentGroups: {},
    configurationPresets: {},
    profiles: {},
  };
  let totalBytes = 0;
  async function load(
    path: string,
    optional: boolean,
    reference?: Pick<FieldOrigin, 'sourceId' | 'pointer'>,
  ): Promise<CompositionSourceDocument | undefined> {
    const report = (message: string): never => fail(message, reference?.sourceId ?? path, reference?.pointer ?? '');
    try {
      await lstat(path);
    } catch (error) {
      if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      report(`Could not read composition source ${path}.`);
    }
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch {
      return report(`Could not resolve composition source ${path}.`);
    }
    const cached = documents.get(canonical);
    if (cached !== undefined) {
      return cached;
    }
    const file = await configurationFile(canonical).catch((error: unknown) =>
      report(
        `Could not read composition source ${path}: ${error instanceof Error ? error.message : 'unreadable file'}`,
      ),
    );
    totalBytes += Buffer.byteLength(file.text, 'utf8');
    if (totalBytes > 8 * 1024 * 1024) {
      fail('Composition sources exceed the 8 MiB total text limit.', path);
    }
    const value = parseCompositionDocument(file.text, canonical);
    freeze(value);
    const source: CompositionSourceDocument = Object.freeze({
      id: canonical,
      path,
      text: file.text,
      fingerprint: createHash('sha256').update(file.text).digest('hex'),
      writable: canonical === path && (file.mode & 0o222) !== 0,
      value,
    });
    documents.set(canonical, source);
    return source;
  }
  function fields(value: unknown, pointer: string, source: CompositionSourceDocument): void {
    provenance[pointer] = {
      sourceId: source.id,
      pointer,
      layer: 'definition',
      operation: 'set',
      references: [],
      overwritten: [],
    };
    if (record(value) || Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        fields(child, `${pointer}/${pointerPart(key)}`, source);
      }
    }
  }
  function register<T>(
    destination: Record<string, T>,
    entries: Record<string, T> | undefined,
    pointer: string,
    source: CompositionSourceDocument,
    normalize: (value: T) => T = (value) => value,
  ): void {
    for (const [name, value] of Object.entries(entries ?? {})) {
      const at = `${pointer}/${pointerPart(name)}`;
      if (Object.hasOwn(destination, name)) {
        fail(
          `Duplicate definition ${at}; first declared in ${provenance[at].sourceId ?? ''}, also declared in ${source.path}. Use an explicit override instead.`,
          source.id,
          at,
        );
      }
      destination[name] = normalize(value);
      fields(value, at, source);
    }
  }
  async function visit(
    source: CompositionSourceDocument,
    path: string,
    ancestors: Set<string>,
    imported: boolean,
  ): Promise<void> {
    if (ancestors.has(source.id)) {
      fail(`Import cycle through ${path}.`, source.id, '/imports');
    }
    if (ancestors.size >= 32) {
      fail('Import chains may contain at most 32 documents.', source.id, '/imports');
    }
    if (visited.has(source.id)) {
      fail(`Duplicate canonical import identity ${path}; already imported from ${source.path}.`, source.id, '/imports');
    }
    if (imported && ['activeProfiles', 'defaults', 'overrides'].some((key) => Object.hasOwn(source.value, key))) {
      fail(
        'Imported documents contribute definitions only. Move activeProfiles, defaults, and overrides to a shared, project, or local scope document.',
        source.id,
      );
    }
    visited.add(source.id);
    for (const [index, reference] of (source.value.imports ?? []).entries()) {
      const nextPath = configurationPath(reference, dirname(path));
      const next = await load(nextPath, false, { sourceId: source.id, pointer: `/imports/${index}` });
      if (next === undefined) {
        fail(`Could not read import ${reference}.`, source.id, `/imports/${index}`);
      }
      await visit(next, nextPath, new Set([...ancestors, source.id]), true);
    }
    const value = source.value;
    register(registry.sourceDirectories, value.sourceDirectories, '/sourceDirectories', source, (item) =>
      configurationPath(item, dirname(path)),
    );
    register(registry.components.agents, value.components?.agents, '/components/agents', source, (item) =>
      relativeFile(item, path),
    );
    register(registry.components.skills, value.components?.skills, '/components/skills', source, (item) =>
      relativeFile(item, path),
    );
    register(registry.components.commands, value.components?.commands, '/components/commands', source, (item) =>
      relativeFile(item, path),
    );
    register(registry.components.prompts, value.components?.prompts, '/components/prompts', source, (item) =>
      relativeFile(item, path),
    );
    register(registry.componentGroups, value.componentGroups, '/componentGroups', source);
    register(registry.configurationPresets, value.configurationPresets, '/configurationPresets', source);
    register(registry.profiles, value.profiles, '/profiles', source);
  }
  const root = resolve(context.root);
  const roots = [
    {
      path: configurationPath(context.baseFile ?? 'config-composer.jsonc', configurationDirectory()),
      optional: !context.baseExplicit,
    },
    { path: join(root, '.opencode/config-composer.jsonc'), optional: true },
    { path: join(root, '.opencode/config-composer.local.jsonc'), optional: true },
  ];
  for (const entry of roots) {
    const source = await load(entry.path, entry.optional);
    if (source === undefined || scopes.some((scope) => scope.id === source.id)) {
      continue;
    }
    await visit(source, entry.path, new Set(), false);
    scopes.push(source);
  }
  if (scopes.length === 0) {
    fail('No Config Composer configuration source was found.');
  }
  let activeProfiles: string[] = [];
  let activeSource: CompositionSourceDocument | undefined;
  for (const source of scopes) {
    if (source.value.activeProfiles !== undefined) {
      activeProfiles = [...source.value.activeProfiles];
      activeSource = source;
    }
  }
  function profileChain(
    name: string,
    ancestors: Set<string>,
    reference?: Pick<FieldOrigin, 'sourceId' | 'pointer'>,
  ): ProfileOccurrence[] {
    if (!Object.hasOwn(registry.profiles, name)) {
      fail(
        `Unknown profile ${name}. Define it inline or import its document.`,
        reference?.sourceId,
        reference?.pointer,
      );
    }
    const origin = provenance[`/profiles/${pointerPart(name)}`];
    if (ancestors.has(name)) {
      fail(`Profile ancestry cycle at ${name}.`, origin.sourceId, `${origin.pointer}/extends`);
    }
    if (ancestors.size >= 32) {
      fail('Profile chains may contain at most 32 levels.', origin.sourceId, origin.pointer);
    }
    const profile = registry.profiles[name];
    for (const [index, layer] of (profile.layers ?? []).entries()) {
      if (layer.componentGroup !== undefined && !Object.hasOwn(registry.componentGroups, layer.componentGroup)) {
        fail(
          `Unknown component group ${layer.componentGroup}.`,
          origin.sourceId,
          `${origin.pointer}/layers/${index}/componentGroup`,
        );
      }
      if (
        layer.configurationPreset !== undefined &&
        !Object.hasOwn(registry.configurationPresets, layer.configurationPreset)
      ) {
        fail(
          `Unknown configuration preset ${layer.configurationPreset}.`,
          origin.sourceId,
          `${origin.pointer}/layers/${index}/configurationPreset`,
        );
      }
      for (const group of layer.target?.componentGroups ?? []) {
        if (!Object.hasOwn(registry.componentGroups, group)) {
          fail(
            `Unknown target component group ${group}.`,
            origin.sourceId,
            `${origin.pointer}/layers/${index}/target/componentGroups`,
          );
        }
      }
    }
    const parent =
      profile.extends === undefined
        ? []
        : profileChain(profile.extends, new Set([...ancestors, name]), {
            sourceId: origin.sourceId,
            pointer: `${origin.pointer}/extends`,
          });
    return [...parent, { name, profile, origin }];
  }
  // Reject broken inactive definitions too; activation never hides invalid input.
  for (const name of Object.keys(registry.profiles)) {
    profileChain(name, new Set());
  }
  const orderedProfiles = activeProfiles.flatMap((name, index) =>
    profileChain(name, new Set(), { sourceId: activeSource?.id, pointer: `/activeProfiles/${index}` }),
  );
  return { documents: [...documents.values()], scopes, registry, provenance, activeProfiles, orderedProfiles };
}
