import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import matter from 'gray-matter';
import jsYaml from 'js-yaml';
import { SettingsError, record } from './settings.ts';

export type AuthoredAgentField = 'model' | 'variant' | 'temperature' | 'top_p' | 'options' | 'mode' | 'permission';

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

// OpenCode v1.19.0 packages/core/src/v1/config/agent.ts. These keys are not provider options.
const nativeAgentKeys = new Set([
  'name',
  'model',
  'variant',
  'prompt',
  'description',
  'temperature',
  'top_p',
  'mode',
  'hidden',
  'color',
  'steps',
  'maxSteps',
  'options',
  'permission',
  'disable',
  'tools',
]);
const directFields = ['model', 'variant', 'temperature', 'top_p', 'mode'] as const;
const actions = new Set(['allow', 'ask', 'deny']);

function diagnostic(path: string, detail: string): SettingsError {
  return new SettingsError(`Native agent frontmatter ${path}: ${detail}`);
}

function jsonValue(value: unknown, parents = new Set<unknown>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (!Array.isArray(value) && (!record(value) || Object.getPrototypeOf(value) !== Object.prototype)) {
    return false;
  }
  if (parents.has(value)) {
    return false;
  }
  const ancestors = new Set([...parents, value]);
  return Object.values(value).every((item: unknown) => jsonValue(item, ancestors));
}

function validateMetadata(data: Record<string, unknown>, path: string): void {
  const invalid = (key: string) => {
    throw diagnostic(path, `invalid native ${key} field; authored authority is unavailable.`);
  };
  // Native overwrites a header's prompt with its body before validation. It is never metadata authority.
  for (const key of ['name', 'model', 'variant', 'description', 'color']) {
    if (Object.hasOwn(data, key) && typeof data[key] !== 'string') {
      invalid(key);
    }
  }
  for (const key of ['temperature', 'top_p']) {
    if (Object.hasOwn(data, key) && (typeof data[key] !== 'number' || !Number.isFinite(data[key]))) {
      invalid(key);
    }
  }
  for (const key of ['disable', 'hidden']) {
    if (Object.hasOwn(data, key) && typeof data[key] !== 'boolean') {
      invalid(key);
    }
  }
  for (const key of ['steps', 'maxSteps']) {
    const value = data[key];
    if (Object.hasOwn(data, key) && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
      invalid(key);
    }
  }
  if (
    Object.hasOwn(data, 'mode') &&
    (typeof data.mode !== 'string' || !['subagent', 'primary', 'all'].includes(data.mode))
  ) {
    invalid('mode');
  }
  if (
    typeof data.color === 'string' &&
    !/^#[\da-f]{6}$/i.test(data.color) &&
    !['primary', 'secondary', 'accent', 'success', 'warning', 'error', 'info'].includes(data.color)
  ) {
    invalid('color');
  }
  if (Object.hasOwn(data, 'options') && !record(data.options)) {
    invalid('options');
  }
  if (
    Object.hasOwn(data, 'tools') &&
    (!record(data.tools) || Object.values(data.tools).some((value) => typeof value !== 'boolean'))
  ) {
    invalid('tools');
  }
  if (Object.hasOwn(data, 'permission')) {
    const permission = data.permission;
    const action = (value: unknown) => typeof value === 'string' && actions.has(value);
    if (
      !action(permission) &&
      (!record(permission) ||
        !Object.entries(permission).every(
          ([key, value]) =>
            action(value) ||
            (!['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop'].includes(key) &&
              record(value) &&
              Object.values(value).every(action)),
        ))
    ) {
      invalid('permission');
    }
  }
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

function parseMetadata(content: string, path: string): Record<string, unknown> {
  // gray-matter removes a UTF-8 BOM before selecting its engine. Match that preflight too.
  const input = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (input.startsWith('---') && input[3] !== '-') {
    const language = matter.language(input).name;
    if (language !== '' && language !== 'json' && !['yaml', 'yml'].includes(language.toLowerCase())) {
      throw diagnostic(
        path,
        `unsupported frontmatter engine ${JSON.stringify(language)}; only YAML and JSON are available.`,
      );
    }
  }
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
  const options = { engines: { yaml, json, javascript: unsupported } };
  try {
    let data: unknown;
    try {
      data = matter(content, options).data;
    } catch {
      data = matter(sanitize(content), options).data;
    }
    if (!record(data)) {
      throw new Error('Native frontmatter must be an object.');
    }
    validateMetadata(data, path);
    return data;
  } catch (error) {
    if (error instanceof SettingsError) {
      throw error;
    }
    throw diagnostic(
      path,
      `could not parse native metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
    if (!jsonValue(value) || !jsonValue(authored)) {
      throw diagnostic(source.path, `cyclic or non-JSON native ${key} field; authored authority is unavailable.`);
    }
    fields[key] = { value, authored, source, ...(derived === undefined ? {} : { derived }) };
  };
  for (const key of directFields) {
    if (Object.hasOwn(data, key)) {
      pin(key, data[key], { [key]: data[key] });
    }
  }
  const extras = Object.fromEntries(Object.entries(data).filter(([key]) => !nativeAgentKeys.has(key)));
  if (Object.hasOwn(data, 'options') || Object.keys(extras).length !== 0) {
    pin(
      'options',
      { ...(record(data.options) ? data.options : {}), ...extras },
      { ...(Object.hasOwn(data, 'options') ? { options: data.options } : {}), ...extras },
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

async function existsDirectory(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) {
      throw diagnostic(path, 'native search root is not a directory.');
    }
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      try {
        await lstat(path);
      } catch (missing) {
        if (missing instanceof Error && 'code' in missing && missing.code === 'ENOENT') {
          return false;
        }
        throw missing;
      }
      throw diagnostic(path, 'native search directory is an unresolved symbolic link.');
    }
    throw error;
  }
}

function sourceRoots(context: NativeFrontmatterContext): string[] {
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

async function readMetadata(path: string): Promise<{ data: Record<string, unknown>; source: NativeFrontmatterSource }> {
  const canonicalPath = await realpath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) {
      throw diagnostic(path, 'native metadata must be a regular file.');
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
      throw diagnostic(path, 'native source changed while reading; retry discovery.');
    }
    const text = bytes.toString('utf8');
    return {
      data: parseMetadata(text, path),
      source: { path, canonicalPath, fingerprint: createHash('sha256').update(bytes).digest('hex') },
    };
  } finally {
    await file.close();
  }
}

/** Read only authored native Markdown metadata. Native normalized configuration is deliberately not an input. */
export async function readNativeAgentFrontmatter(
  context: NativeFrontmatterContext,
): Promise<Map<string, NativeAgentFrontmatter>> {
  const agents = new Map<string, NativeAgentFrontmatter>();
  let activePath = context.directory;
  try {
    for (const root of sourceRoots(context)) {
      activePath = root;
      if (!(await existsDirectory(root))) {
        continue;
      }
      for (const primary of [false, true]) {
        const batch = new Map<string, string>();
        const scan = async (directory: string, base: string, parents = new Set<string>()): Promise<void> => {
          activePath = directory;
          const canonical = await realpath(directory);
          if (parents.has(canonical)) {
            throw diagnostic(directory, 'native search contains a directory cycle.');
          }
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            activePath = path;
            const info = entry.isSymbolicLink() ? await stat(path) : await lstat(path);
            if (info.isDirectory()) {
              if (!primary) {
                await scan(path, base, new Set([...parents, canonical]));
              }
              continue;
            }
            if (!info.isFile() || !entry.name.endsWith('.md')) {
              continue;
            }
            const { data, source } = await readMetadata(path);
            const candidate = relative(base, path).replaceAll('\\', '/');
            const extension = extname(candidate);
            const name =
              typeof data.name === 'string'
                ? data.name
                : extension === ''
                  ? candidate
                  : candidate.slice(0, -extension.length);
            const previous = batch.get(name);
            if (previous !== undefined) {
              throw diagnostic(
                path,
                `ambiguous native agent ${JSON.stringify(name)} in one traversal batch: ${previous} and ${path}.`,
              );
            }
            batch.set(name, path);
            const earlier = agents.get(name);
            agents.set(name, {
              fields: { ...earlier?.fields, ...authoredFields(data, source, primary) },
              sources: [...(earlier?.sources ?? []), source],
            });
          }
        };
        for (const name of primary ? ['mode', 'modes'] : ['agent', 'agents']) {
          const directory = join(root, name);
          activePath = directory;
          if (await existsDirectory(directory)) {
            await scan(directory, directory);
          }
        }
      }
    }
    return agents;
  } catch (error) {
    if (error instanceof SettingsError) {
      throw error;
    }
    throw diagnostic(
      activePath,
      `could not read native source: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
