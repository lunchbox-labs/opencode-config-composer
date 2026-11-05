import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { SettingsError, record } from './settings.ts';
import { type AgentConfigKey, actionOnlyPermissions } from './host.ts';
import { readAgentGroups, withoutGroups } from './membership.ts';

export type AuthoredAgentField =
  'model' | 'variant' | 'temperature' | 'top_p' | 'steps' | 'options' | 'mode' | 'permission' | 'disable';

export interface NativeFrontmatterSource {
  /** Lexical native discovery path; aliases retain their native identity. */
  path: string;
  canonicalPath: string;
  /** SHA-256 of the exact bytes read, including the opaque body. */
  fingerprint: string;
}

export interface AuthoredAgentValue {
  /** The actual authored value, with only native field normalization applied. */
  value: unknown;
  /** Raw own properties contributing to this field, before native normalization. */
  authored: Record<string, unknown>;
  source: NativeFrontmatterSource;
  derived?: 'primary-mode';
}

export interface NativeAgentFrontmatter {
  /** Last explicitly authored membership array; absent later sources do not clear it. */
  groups?: { value: string[]; source: NativeFrontmatterSource };
  /** An own field entry means presence, including false, zero, empty strings and objects. */
  fields: Partial<Record<AuthoredAgentField, AuthoredAgentValue>>;
  sources: NativeFrontmatterSource[];
}

export interface NativeFrontmatterContext {
  directory: string;
  worktree: string;
  environment?: NodeJS.ProcessEnv;
  /** Actual OS home; OPENCODE_TEST_HOME changes only the native .opencode search. */
  home?: string;
}

// OpenCode v1.19.0 packages/core/src/v1/config/agent.ts, plus Composer groups metadata.
// These keys are not provider options.
const nativeAgentKeys = new Set(
  Object.keys({
    name: true,
    groups: true,
    model: true,
    variant: true,
    prompt: true,
    description: true,
    temperature: true,
    top_p: true,
    mode: true,
    hidden: true,
    color: true,
    steps: true,
    maxSteps: true,
    options: true,
    permission: true,
    disable: true,
    tools: true,
  } satisfies Record<AgentConfigKey | 'name' | 'groups', true>),
);
const directFields = ['model', 'variant', 'temperature', 'top_p', 'mode', 'disable'] as const;
const actions = new Set(['allow', 'ask', 'deny']);

function diagnostic(path: string, detail: string): SettingsError {
  return new SettingsError(`Native agent frontmatter ${path}: ${detail}`);
}

/** A JSON copy, with YAML dates as ISO strings; undefined for cycles and other non-JSON values. */
function jsonCopy(value: unknown, parents = new Set<unknown>()): { value: unknown } | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value } : undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : { value: value.toISOString() };
  }
  if (!Array.isArray(value) && (!record(value) || Object.getPrototypeOf(value) !== Object.prototype)) {
    return undefined;
  }
  if (parents.has(value)) {
    return undefined;
  }
  const ancestors = new Set([...parents, value]);
  const items: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    const copy = jsonCopy(item, ancestors);
    if (copy === undefined) {
      return undefined;
    }
    items.push([key, copy.value]);
  }
  return { value: Array.isArray(value) ? items.map(([, item]) => item) : Object.fromEntries(items) };
}

const colorNames = ['primary', 'secondary', 'accent', 'success', 'warning', 'error', 'info'];

function validField(data: Record<string, unknown>, key: string): boolean {
  const value = data[key];
  const action = (item: unknown) => typeof item === 'string' && actions.has(item);
  switch (key) {
    case 'name':
    case 'model':
    case 'variant':
    case 'description':
      return typeof value === 'string';
    case 'color':
      return typeof value === 'string' && (/^#[\da-f]{6}$/i.test(value) || colorNames.includes(value));
    case 'temperature':
    case 'top_p':
      return typeof value === 'number';
    case 'disable':
    case 'hidden':
      return typeof value === 'boolean';
    case 'steps':
    case 'maxSteps':
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    case 'mode':
      return typeof value === 'string' && ['subagent', 'primary', 'all'].includes(value);
    case 'options':
      return record(value);
    case 'tools':
      return record(value) && Object.values(value).every((enabled) => typeof enabled === 'boolean');
    case 'permission':
      return (
        action(value) ||
        (record(value) &&
          Object.entries(value).every(
            ([tool, policy]) =>
              action(policy) ||
              (!actionOnlyPermissions.has(tool) && record(policy) && Object.values(policy).every(action)),
          ))
      );
    default:
      return true;
  }
}

/** Header fields that native OpenCode would accept; anything else is treated as not authored. */
function authoredMetadata(data: Record<string, unknown>, path: string, warnings: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const copy = key === 'groups' ? { value } : jsonCopy(value);
    if (copy === undefined || !validField({ [key]: copy.value }, key)) {
      warnings.push(`ignored invalid \`${key}\` in \`${path}\`.`);
      continue;
    }
    Object.defineProperty(result, key, {
      value: key === 'groups' ? readAgentGroups(value, `\`${path}\``, warnings) : copy.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

// Copy native config/markdown.ts's fallback, including its deliberately limited key grammar.
function sanitize(content: string): string {
  return content.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_match, header: string) => {
    const lines = header.split(/\r?\n/).flatMap((line) => {
      if (/^\s*(?:#|$)/.test(line) || /^\s/.test(line)) {
        return [line];
      }
      // eslint-disable-next-line regexp/prefer-w, regexp/use-ignore-case, regexp/no-super-linear-backtracking -- Preserve the exact pinned native fallback grammar.
      const entry = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (entry === null) {
        return [line];
      }
      const [, key, raw] = entry;
      const value = raw.trim();
      if (
        value === '' ||
        value === '>' ||
        value === '|' ||
        value.startsWith('"') ||
        value.startsWith("'") ||
        !value.includes(':')
      ) {
        return [line];
      }
      return [`${key}: |-`, `  ${value}`];
    });
    return `---\n${lines.join('\n')}\n---`;
  });
}

// The TUI parses frontmatter only while verifying a profile, so load the parsers on first use, not at startup.
let parsers: ReturnType<typeof importParsers> | undefined;
async function importParsers() {
  const [{ default: matter }, { default: jsYaml }] = await Promise.all([import('gray-matter'), import('js-yaml')]);
  return { matter, jsYaml };
}

/** Parse a Markdown header with only the safe YAML and JSON engines, without native's lenient fallback. */
export async function frontmatterData(content: string, path: string): Promise<unknown> {
  const { matter, jsYaml } = await (parsers ??= importParsers());
  const yaml = (text: string): object => {
    const value: unknown = jsYaml.safeLoad(text);
    if (!record(value)) {
      throw new Error('Native frontmatter must be an object.');
    }
    return value;
  };
  const json = (text: string): object => {
    const value: unknown = JSON.parse(text);
    if (!record(value)) {
      throw new Error('Native frontmatter must be an object.');
    }
    return value;
  };
  const unsupported = (): never => {
    throw diagnostic(path, 'unsupported executable frontmatter engine.');
  };
  // Passing options is essential: gray-matter otherwise caches entire files, including prompt bodies.
  return matter(content, { engines: { yaml, json, javascript: unsupported } }).data;
}

/** A header that can't be parsed safely contributes no settings, as if the file had none. */
async function parseMetadata(content: string, path: string, warnings: string[]): Promise<Record<string, unknown>> {
  const { matter } = await (parsers ??= importParsers());
  const unparsable = () => {
    warnings.push(`could not parse \`${path}\`; its settings were ignored.`);
    return {};
  };
  // gray-matter removes a UTF-8 BOM before selecting its engine. Match that preflight too.
  const input = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (input.startsWith('---') && input[3] !== '-') {
    const language = matter.language(input).name;
    if (language !== '' && language !== 'json' && !['yaml', 'yml'].includes(language.toLowerCase())) {
      return unparsable();
    }
  }
  let data: unknown;
  try {
    try {
      data = await frontmatterData(content, path);
    } catch {
      data = await frontmatterData(sanitize(content), path);
    }
  } catch {
    return unparsable();
  }
  return record(data) ? authoredMetadata(data, path, warnings) : unparsable();
}

function authoredFields(
  data: Record<string, unknown>,
  source: NativeFrontmatterSource,
  primary: boolean,
): NativeAgentFrontmatter['fields'] {
  const fields: NativeAgentFrontmatter['fields'] = {};
  const pin = (
    key: AuthoredAgentField,
    value: unknown,
    authored: Record<string, unknown>,
    derived?: 'primary-mode',
  ) => {
    fields[key] = { value, authored, source, ...(derived === undefined ? {} : { derived }) };
  };
  for (const key of directFields) {
    if (Object.hasOwn(data, key)) {
      pin(key, data[key], { [key]: data[key] });
    }
  }
  // Native decodes each source as steps ?? maxSteps before merging sources.
  if (Object.hasOwn(data, 'steps') || Object.hasOwn(data, 'maxSteps')) {
    pin('steps', data.steps ?? data.maxSteps, {
      ...(Object.hasOwn(data, 'steps') ? { steps: data.steps } : {}),
      ...(Object.hasOwn(data, 'maxSteps') ? { maxSteps: data.maxSteps } : {}),
    });
  }
  const extras = Object.fromEntries(Object.entries(data).filter(([key]) => !nativeAgentKeys.has(key)));
  if (Object.hasOwn(data, 'options') || Object.keys(extras).length !== 0) {
    pin(
      'options',
      { ...(record(data.options) ? withoutGroups(data.options) : {}), ...extras },
      {
        ...(Object.hasOwn(data, 'options')
          ? { options: record(data.options) ? withoutGroups(data.options) : data.options }
          : {}),
        ...extras,
      },
    );
  }
  if (Object.hasOwn(data, 'tools') || Object.hasOwn(data, 'permission')) {
    const tools = record(data.tools)
      ? Object.fromEntries(
          Object.entries(data.tools).map(([key, enabled]) => [
            ['write', 'edit', 'patch'].includes(key) ? 'edit' : key,
            enabled === true ? 'allow' : 'deny',
          ]),
        )
      : {};
    const permission =
      typeof data.permission === 'string' ? { '*': data.permission } : record(data.permission) ? data.permission : {};
    pin(
      'permission',
      { ...tools, ...permission },
      {
        ...(Object.hasOwn(data, 'tools') ? { tools: data.tools } : {}),
        ...(Object.hasOwn(data, 'permission') ? { permission: data.permission } : {}),
      },
    );
  }
  if (primary && Object.hasOwn(data, 'mode')) {
    pin('mode', 'primary', { mode: data.mode }, 'primary-mode');
  }
  return fields;
}

/** Missing roots, roots that aren't directories, unresolved links and unreadable roots have no agents. */
async function existsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function nativeAgentSourceRoots(context: NativeFrontmatterContext): string[] {
  const environment = context.environment ?? process.env;
  const home = context.home ?? homedir();
  const xdg = environment.XDG_CONFIG_HOME;
  const roots = [join(xdg === undefined || xdg === '' ? join(home, '.config') : xdg, 'opencode')];
  if (!['true', '1'].includes(environment.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase() ?? '')) {
    const inside = relative(context.worktree, context.directory);
    if (context.worktree !== '/' && (inside === '..' || inside.startsWith(`..${sep}`))) {
      throw diagnostic(context.directory, 'native project directory is outside its worktree.');
    }
    for (let current = context.directory; ; current = dirname(current)) {
      roots.push(join(current, '.opencode'));
      if (current === context.worktree || dirname(current) === current) {
        break;
      }
    }
  }
  roots.push(join(environment.OPENCODE_TEST_HOME ?? home, '.opencode'));
  const custom = environment.OPENCODE_CONFIG_DIR;
  if (custom !== undefined && custom !== '') {
    roots.push(custom);
  }
  return [...new Set(roots)];
}

interface MetadataRead {
  data: Record<string, unknown>;
  source: NativeFrontmatterSource;
}

/** Undefined when the file kept changing or stopped being a regular file while it was read. */
async function readStableMetadata(path: string, warnings: string[]): Promise<MetadataRead | undefined> {
  const canonicalPath = await realpath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) {
      return undefined;
    }
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const current = await stat(path, { bigint: true });
    if (
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      canonicalPath !== (await realpath(path))
    ) {
      return undefined;
    }
    return {
      data: await parseMetadata(bytes.toString('utf8'), path, warnings),
      source: { path, canonicalPath, fingerprint: createHash('sha256').update(bytes).digest('hex') },
    };
  } finally {
    await file.close();
  }
}

async function readMetadata(path: string, warnings: string[]): Promise<MetadataRead | undefined> {
  try {
    // A file that changes mid-read is read once more before it is skipped.
    for (const _attempt of [1, 2]) {
      const attemptWarnings: string[] = [];
      const read = await readStableMetadata(path, attemptWarnings);
      if (read !== undefined) {
        warnings.push(...attemptWarnings);
        return read;
      }
    }
    warnings.push(`\`${path}\` changed while it was read; its settings were ignored.`);
    return undefined;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    warnings.push(`could not read \`${path}\`; its settings were ignored.`);
    return undefined;
  }
}

async function listDirectory(directory: string) {
  try {
    return { canonical: await realpath(directory), entries: await readdir(directory, { withFileTypes: true }) };
  } catch {
    return undefined;
  }
}

/**
 * Read only authored native Markdown metadata. Native normalized configuration is deliberately not an input.
 * Unreadable folders, dangling links and directory cycles are skipped; `warnings` names settings that were ignored.
 */
export async function readNativeAgentFrontmatter(
  context: NativeFrontmatterContext,
  warnings: string[] = [],
): Promise<Map<string, NativeAgentFrontmatter>> {
  interface EntryRead {
    path: string;
    directory: boolean;
    metadata?: MetadataRead;
    warnings: string[];
  }
  const agents = new Map<string, NativeAgentFrontmatter>();
  for (const root of nativeAgentSourceRoots(context)) {
    if (!(await existsDirectory(root))) {
      continue;
    }
    for (const primary of [false, true]) {
      const beforeBatch = new Map(agents);
      const batch = new Map<string, string>();
      const scan = async (directory: string, base: string, parents = new Set<string>()): Promise<void> => {
        const listing = await listDirectory(directory);
        if (listing === undefined || parents.has(listing.canonical)) {
          return;
        }
        const { canonical, entries } = listing;
        // Read entries concurrently, then recurse and merge in readdir order. Reads never touch shared state.
        // Each read may hold a descriptor; one directory reads at a time, so this bounds the whole traversal.
        const reads: (EntryRead | undefined)[] = [];
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(16, entries.length) }, async () => {
            while (next < entries.length) {
              const index = next++;
              const entry = entries[index];
              const path = join(directory, entry.name);
              const info = await (entry.isSymbolicLink() ? stat(path) : lstat(path)).catch(() => undefined);
              if (info === undefined) {
                continue;
              }
              const entryWarnings: string[] = [];
              reads[index] = {
                path,
                directory: info.isDirectory(),
                metadata:
                  info.isFile() && entry.name.endsWith('.md') ? await readMetadata(path, entryWarnings) : undefined,
                warnings: entryWarnings,
              };
            }
          }),
        );
        for (const read of reads) {
          if (read === undefined) {
            continue;
          }
          warnings.push(...read.warnings);
          if (read.directory) {
            if (!primary) {
              await scan(read.path, base, new Set([...parents, canonical]));
            }
            continue;
          }
          if (read.metadata === undefined) {
            continue;
          }
          const { data, source } = read.metadata;
          const candidate = relative(base, read.path).replaceAll('\\', '/');
          const extension = extname(candidate);
          const name =
            typeof data.name === 'string'
              ? data.name
              : extension === ''
                ? candidate
                : candidate.slice(0, -extension.length);
          const previous = batch.get(name);
          if (previous !== undefined) {
            warnings.push(`\`${previous}\` and \`${read.path}\` both define agent \`${name}\`; used \`${read.path}\`.`);
          }
          batch.set(name, read.path);
          // Within one batch the later file replaces the earlier one; earlier batches still merge underneath.
          const earlier = previous === undefined ? agents.get(name) : beforeBatch.get(name);
          agents.set(name, {
            ...(Object.hasOwn(data, 'groups')
              ? { groups: { value: readAgentGroups(data.groups, source.path), source } }
              : earlier?.groups === undefined
                ? {}
                : { groups: earlier.groups }),
            fields: { ...earlier?.fields, ...authoredFields(data, source, primary) },
            sources: [...(agents.get(name)?.sources ?? []), source],
          });
        }
      };
      for (const name of primary ? ['mode', 'modes'] : ['agent', 'agents']) {
        const directory = join(root, name);
        if (await existsDirectory(directory)) {
          await scan(directory, directory);
        }
      }
    }
  }
  return agents;
}
