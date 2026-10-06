import { realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { configurationFile } from '../configuration.ts';
import { type AgentSettings, SettingsError, record } from '../settings.ts';
import type { LoadedSources } from './sources.ts';

async function text(path: string): Promise<string> {
  try {
    const file = await configurationFile(await realpath(path));
    if (file.text.includes('\0')) {
      throw new SettingsError('Component files must not contain NUL bytes.');
    }
    return file.text.trim();
  } catch (error) {
    throw new SettingsError(
      `Could not read component ${path}: ${error instanceof Error ? error.message : 'unreadable file'}`,
    );
  }
}
function safe(value: unknown, depth = 0): void {
  if (depth > 32) {
    throw new SettingsError('Component frontmatter exceeds 32 levels.');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new SettingsError('Component frontmatter numbers must be finite.');
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new SettingsError('Component frontmatter requires plain objects.');
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new SettingsError('Component frontmatter contains an unsafe property.');
      }
      safe(child, depth + 1);
    }
  }
}
async function markdown(path: string): Promise<{ metadata: Record<string, unknown>; body: string }> {
  const content = await text(path);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (match === null) {
    throw new SettingsError(`Component ${path} requires YAML frontmatter.`);
  }
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length !== 0) {
    throw new SettingsError(`Component ${path} has invalid or duplicate frontmatter.`);
  }
  const metadata: unknown = document.toJS({ maxAliasCount: 0 });
  if (!record(metadata)) {
    throw new SettingsError(`Component ${path} requires object frontmatter.`);
  }
  safe(metadata);
  return { metadata, body: content.slice(match[0].length).trim() };
}
// Match the pinned host's frontmatter normalization before bypassing its file discovery.
function nativeAgent(metadata: AgentSettings): AgentSettings {
  for (const field of ['name', 'model', 'variant', 'prompt', 'description', 'color'] as const) {
    if (metadata[field] !== undefined && typeof metadata[field] !== 'string') {
      throw new SettingsError(`Native agent frontmatter ${field} must be a string.`);
    }
  }
  for (const field of ['disable', 'hidden'] as const) {
    if (metadata[field] !== undefined && typeof metadata[field] !== 'boolean') {
      throw new SettingsError(`Native agent frontmatter ${field} must be boolean.`);
    }
  }
  for (const field of ['temperature', 'top_p'] as const) {
    if (metadata[field] !== undefined && (typeof metadata[field] !== 'number' || !Number.isFinite(metadata[field]))) {
      throw new SettingsError(`Native agent frontmatter ${field} must be finite.`);
    }
  }
  for (const field of ['steps', 'maxSteps'] as const) {
    const value = metadata[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) {
      throw new SettingsError(`Native agent frontmatter ${field} must be a positive integer.`);
    }
  }
  if (
    metadata.mode !== undefined &&
    (typeof metadata.mode !== 'string' || !['primary', 'subagent', 'all'].includes(metadata.mode))
  ) {
    throw new SettingsError('Native agent frontmatter mode must be primary, subagent, or all.');
  }
  if (
    typeof metadata.color === 'string' &&
    !/^#[0-9a-f]{6}$/i.test(metadata.color) &&
    !['primary', 'secondary', 'accent', 'success', 'warning', 'error', 'info'].includes(metadata.color)
  ) {
    throw new SettingsError('Native agent frontmatter color must be a hex or theme color.');
  }
  if (metadata.options !== undefined && !record(metadata.options)) {
    throw new SettingsError('Native agent frontmatter options must be an object.');
  }
  const action = (value: unknown) => typeof value === 'string' && ['allow', 'ask', 'deny'].includes(value);
  const permissionValue = metadata.permission;
  if (
    permissionValue !== undefined &&
    !action(permissionValue) &&
    !(
      record(permissionValue) &&
      Object.values(permissionValue).every(
        (value) => action(value) || (record(value) && Object.values(value).every(action)),
      )
    )
  ) {
    throw new SettingsError('Native agent frontmatter permission contains an invalid action.');
  }
  const known = new Set([
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
  const options = { ...metadata.options };
  for (const [key, value] of Object.entries(metadata)) {
    if (!known.has(key)) {
      options[key] = value;
    }
  }
  const permission: Record<string, unknown> = {};
  if (metadata.tools !== undefined) {
    if (!record(metadata.tools) || !Object.values(metadata.tools).every((value) => typeof value === 'boolean')) {
      throw new SettingsError('Native agent tools must map names to boolean values.');
    }
    for (const [tool, value] of Object.entries(metadata.tools)) {
      permission[['write', 'edit', 'patch'].includes(tool) ? 'edit' : tool] = value === true ? 'allow' : 'deny';
    }
  }
  if (typeof metadata.permission === 'string') {
    permission['*'] = metadata.permission;
  } else if (record(metadata.permission)) {
    Object.assign(permission, metadata.permission);
  }
  return {
    ...metadata,
    options,
    ...(Object.keys(permission).length > 0 ? { permission } : {}),
    ...(metadata.steps !== undefined || metadata.maxSteps !== undefined
      ? { steps: metadata.steps ?? metadata.maxSteps }
      : {}),
  };
}
export async function loadComponents(sources: LoadedSources, available: Record<string, AgentSettings>) {
  const components = sources.registry.components;
  const agents: Record<string, AgentSettings> = {};
  const prompts: Record<string, string> = {};
  const commands: Record<
    string,
    { template: string; agent?: string; model?: string; description?: string; subtask?: boolean }
  > = {};
  const skills: Record<string, string> = {};
  for (const [name, value] of Object.entries(components?.prompts ?? {})) {
    prompts[name] = value.file === undefined ? value.text : await text(value.file);
  }
  for (const [name, value] of Object.entries(components?.skills ?? {})) {
    if (basename(value.file) !== 'SKILL.md') {
      throw new SettingsError(`Skill ${name} must name its native SKILL.md file.`);
    }
    const file = await markdown(value.file);
    if (file.metadata.name !== name || typeof file.metadata.description !== 'string') {
      throw new SettingsError(`Skill ${name} requires matching name and description frontmatter in ${value.file}.`);
    }
    skills[name] = dirname(value.file);
  }
  for (const [name, value] of Object.entries(components?.agents ?? {})) {
    if (Object.hasOwn(available, name)) {
      throw new SettingsError(
        `Component agent ${name} conflicts with an existing native or custom agent. Select it by name and use configuration overrides instead.`,
      );
    }
    const file = value.file === undefined ? { metadata: {}, body: value.prompt } : await markdown(value.file);
    const metadata: AgentSettings = file.metadata;
    if (metadata.name !== undefined && metadata.name !== name) {
      throw new SettingsError(`Agent frontmatter name must match component identity ${name}.`);
    }
    if (value.description !== undefined) {
      metadata.description = value.description;
    }
    if (value.mode !== undefined) {
      metadata.mode = value.mode;
    }
    if (value.disable !== undefined) {
      metadata.disable = value.disable;
    }
    for (const skill of value.skills ?? []) {
      if (!Object.hasOwn(skills, skill)) {
        throw new SettingsError(`Agent ${name} names missing skill ${skill}.`);
      }
    }
    const parts = [file.body];
    for (const prompt of value.promptRefs ?? []) {
      if (!Object.hasOwn(prompts, prompt)) {
        throw new SettingsError(`Agent ${name} names missing prompt ${prompt}.`);
      }
      parts.push(prompts[prompt]);
    }
    agents[name] = { ...nativeAgent(metadata), prompt: parts.join('\n\n') };
  }
  for (const [name, value] of Object.entries(components?.commands ?? {})) {
    const file = value.file === undefined ? { metadata: {}, body: value.template } : await markdown(value.file);
    const metadata: Record<string, unknown> = { ...file.metadata, ...value };
    if (
      (metadata.agent !== undefined && typeof metadata.agent !== 'string') ||
      (metadata.model !== undefined && typeof metadata.model !== 'string') ||
      (metadata.description !== undefined && typeof metadata.description !== 'string') ||
      (metadata.subtask !== undefined && typeof metadata.subtask !== 'boolean')
    ) {
      throw new SettingsError(`Command ${name} has invalid frontmatter.`);
    }
    commands[name] = {
      template: file.body,
      ...(typeof metadata.agent === 'string' ? { agent: metadata.agent } : {}),
      ...(typeof metadata.model === 'string' ? { model: metadata.model } : {}),
      ...(typeof metadata.description === 'string' ? { description: metadata.description } : {}),
      ...(typeof metadata.subtask === 'boolean' ? { subtask: metadata.subtask } : {}),
    };
  }
  return { agents, prompts, commands, skills };
}
