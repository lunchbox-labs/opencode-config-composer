import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  type AgentSettings,
  type GroupOptions,
  type PromptOperations,
  SettingsError,
  agentGroups,
} from './settings.ts';

export const MAX_SNIPPET_BYTES = 64 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_INCLUDE_DEPTH = 32;
export const MAX_INCLUDES = 256;

const INCLUDE = /\\?\{\{include:([^{}]*)\}\}|\\?\{\{include:/g;
const SOURCE_REFERENCE = /^@([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/(.+)$/;

interface Expansion {
  sources: Record<string, string>;
  includes: number;
}

function promptSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
    throw new SettingsError('The composed prompt exceeds the 256 KiB limit.');
  }
}

function contained(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function safeSnippetPath(path: string): boolean {
  return (
    !path.includes('\\') &&
    !path.includes(':') &&
    !Array.from(path).some((character) => character.charCodeAt(0) < 32) &&
    !isAbsolute(path) &&
    !path.split('/').some((part) => part === '..' || part === '.' || part === '' || part.startsWith('.')) &&
    ['.md', '.txt'].includes(extname(path).toLowerCase())
  );
}

async function snippet(reference: string, sources: Record<string, string>): Promise<{ text: string; path: string }> {
  const match = SOURCE_REFERENCE.exec(reference);
  if (match === null) {
    throw new SettingsError('Use @source/path.md or @source/path.txt in a prompt include.');
  }
  const [, alias, path] = match;
  const root = sources[alias];
  if (!Object.hasOwn(sources, alias) || root === '') {
    throw new SettingsError(`Prompt source ${alias} does not exist. Configure it in sourceDirectories.`);
  }
  if (!safeSnippetPath(path)) {
    throw new SettingsError('Prompt includes require a safe relative .md or .txt file path.');
  }
  try {
    const sourceRoot = await realpath(root);
    const target = await realpath(resolve(sourceRoot, path));
    if (!contained(sourceRoot, target)) {
      throw new SettingsError('A prompt include escapes its configured source directory.');
    }
    if (!safeSnippetPath(relative(sourceRoot, target).split(sep).join('/'))) {
      throw new SettingsError('A prompt include resolves to an unsafe file path.');
    }
    const before = await lstat(target);
    if (!before.isFile() || before.size > MAX_SNIPPET_BYTES) {
      throw new SettingsError('Prompt snippets must be regular UTF-8 files no larger than 64 KiB.');
    }
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await file.stat();
      if (
        !current.isFile() ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        current.size > MAX_SNIPPET_BYTES
      ) {
        throw new SettingsError('A prompt snippet changed while loading. Try again.');
      }
      const bytes = await file.readFile();
      if (bytes.length > MAX_SNIPPET_BYTES) {
        throw new SettingsError('Prompt snippets must be no larger than 64 KiB.');
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) {
        throw new SettingsError('Prompt snippets must contain text without NUL bytes.');
      }
      return { text: text.trim(), path: target };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof SettingsError) {
      throw error;
    }
    throw new SettingsError(`Could not read prompt include ${reference}. Check its source directory and file.`);
  }
}

async function expand(text: string, context: Expansion, stack: string[]): Promise<string> {
  promptSize(text);
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(INCLUDE)) {
    result += text.slice(cursor, match.index);
    const marker = match[0];
    if (marker.startsWith('\\')) {
      result += marker.slice(1);
    } else {
      const reference = match.at(1);
      if (reference === undefined) {
        throw new SettingsError('A prompt include has invalid syntax. Use {{include:@source/path.md}}.');
      }
      context.includes += 1;
      if (context.includes > MAX_INCLUDES || stack.length >= MAX_INCLUDE_DEPTH) {
        throw new SettingsError('The prompt include count or nesting limit was exceeded.');
      }
      const included = await snippet(reference, context.sources);
      if (stack.includes(included.path)) {
        throw new SettingsError('The prompt includes contain a cycle. Remove the recursive include.');
      }
      result += await expand(included.text, context, [...stack, included.path]);
    }
    promptSize(result);
    cursor = match.index + marker.length;
  }
  result += text.slice(cursor);
  promptSize(result);
  return result;
}

function operation(text: string): string {
  return SOURCE_REFERENCE.test(text) ? `{{include:${text}}}` : text;
}

export async function expandIncludes(text: string, sources: Record<string, string>): Promise<string> {
  return expand(text, { sources, includes: 0 }, []);
}

export async function composePrompts(
  agents: Record<string, AgentSettings>,
  settings: GroupOptions,
): Promise<Record<string, string>> {
  const composed: Record<string, string> = {};
  for (const [name, agent] of Object.entries(agents)) {
    if (agent.disable === true || typeof agent.prompt !== 'string' || agent.prompt.trim() === '') {
      continue;
    }
    const policy = settings.agentPrompts[name] ?? {};
    const operations: PromptOperations[] = [];
    if (policy.inheritDefaults !== false) {
      operations.push(settings.promptDefaults);
    }
    if (policy.inheritGroups !== false) {
      for (const group of agentGroups(agent, settings.groups)) {
        if (Object.hasOwn(settings.groups, group) && settings.groups[group].prompt !== undefined) {
          operations.push(settings.groups[group].prompt);
        }
      }
    }
    operations.push(policy);
    const parts = [
      ...operations.flatMap((item) => item.prepend ?? []).map(operation),
      agent.prompt,
      ...operations.flatMap((item) => item.append ?? []).map(operation),
    ];
    const context: Expansion = { sources: settings.promptSources, includes: 0 };
    const expanded: string[] = [];
    for (const part of parts) {
      expanded.push(await expand(part, context, []));
    }
    composed[name] = expanded.filter((part) => part !== '').join('\n\n');
    promptSize(composed[name]);
  }
  return composed;
}
