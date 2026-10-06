import { type Node as JsonNode, type ParseError, parseTree } from 'jsonc-parser';
import { SettingsError, record } from '../settings.ts';
import { MAX_CONFIGURATION_BYTES } from '../configuration.ts';

export interface ModelParameters {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  options?: Record<string, unknown>;
}

const controls = ['temperature', 'topP', 'topK', 'maxOutputTokens'] as const;
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);

function jsonValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'object') {
    throw new SettingsError('Custom options require JSON values and finite numbers.');
  }
  if (depth >= 32) {
    throw new SettingsError('Custom options support at most 32 levels of objects and arrays.');
  }
  if (Array.isArray(value)) {
    return Array.from(value, (item: unknown) => jsonValue(item, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new SettingsError('Custom options require plain JSON objects.');
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (unsafe.has(key)) {
        throw new SettingsError('Custom options must not contain unsafe prototype keys.');
      }
      return [key, jsonValue(item, depth + 1)];
    }),
  );
}

export function parseParameters(value: unknown): ModelParameters {
  if (!record(value) || Object.keys(value).some((key) => ![...controls, 'options'].includes(key))) {
    throw new SettingsError('Parameters support temperature, topP, topK, maxOutputTokens, and options.');
  }
  const result: ModelParameters = {};
  for (const key of controls) {
    const item = value[key];
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (
      typeof item !== 'number' ||
      !Number.isFinite(item) ||
      (key === 'temperature' && (item < 0 || item > 2)) ||
      (key === 'topP' && (item < 0 || item > 1)) ||
      ((key === 'topK' || key === 'maxOutputTokens') && (!Number.isSafeInteger(item) || item < 1))
    ) {
      throw new SettingsError(
        'Use temperature 0–2, topP 0–1, and positive safe integers for topK and maxOutputTokens.',
      );
    }
    result[key] = item;
  }
  if (Object.hasOwn(value, 'options')) {
    if (!record(value.options)) {
      throw new SettingsError('Custom options must be a JSON object.');
    }
    const options = jsonValue(value.options);
    if (!record(options)) {
      throw new SettingsError('Custom options must be a JSON object.');
    }
    if (Buffer.byteLength(JSON.stringify(options), 'utf8') > MAX_CONFIGURATION_BYTES) {
      throw new SettingsError('Custom options must be no larger than 1 MiB.');
    }
    result.options = options;
  }
  return result;
}

function checkTree(node: JsonNode, depth = 0): void {
  if (node.type === 'object' || node.type === 'array') {
    if (depth >= 32) {
      throw new SettingsError('Custom options support at most 32 levels of objects and arrays.');
    }
    if (node.type === 'object') {
      const keys = node.children?.map((child): unknown => child.children?.[0].value) ?? [];
      if (new Set(keys).size !== keys.length) {
        throw new SettingsError('Custom options must not contain duplicate JSON keys.');
      }
    }
    depth++;
  }
  node.children?.forEach((child) => checkTree(child, depth));
}

export function parseCustomOptions(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIGURATION_BYTES) {
    throw new SettingsError('Custom options must be no larger than 1 MiB.');
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (tree === undefined || errors.length !== 0 || tree.type !== 'object') {
    throw new SettingsError('Custom options require a valid JSON object.');
  }
  checkTree(tree);
  const value: unknown = JSON.parse(text);
  return parseParameters({ options: value }).options ?? {};
}

export function parametersForDispatch(
  target: string,
  selected: string,
  parameters: ModelParameters,
): ModelParameters | undefined {
  return target === selected ? parseParameters(parameters) : undefined;
}

// Merge JSON objects; arrays, nulls and scalars replace. Both sources have already been validated.
export function mergeOptions(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(next)])].map((key) => {
      const left = base[key];
      const right = next[key];
      return [
        key,
        !Object.hasOwn(next, key) ? left : record(left) && record(right) ? mergeOptions(left, right) : right,
      ];
    }),
  );
}

export function mergeParameters(base: ModelParameters = {}, next: ModelParameters = {}): ModelParameters {
  return {
    ...base,
    ...next,
    ...(base.options !== undefined || next.options !== undefined
      ? { options: mergeOptions(base.options ?? {}, next.options ?? {}) }
      : {}),
  };
}

// Keep native agent pins and selected variants in the already resolved output, including nested paths.
export function unprotectedOptions(
  options: Record<string, unknown>,
  protectedValues: Record<string, unknown>[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).flatMap(([key, value]) => {
      const owners = protectedValues.filter((item) => Object.hasOwn(item, key));
      if (owners.length === 0) {
        return [[key, value]];
      }
      if (!record(value) || owners.some((item) => !record(item[key]))) {
        return [];
      }
      const nested = unprotectedOptions(value, owners.map((item) => item[key]).filter(record));
      return Object.keys(nested).length === 0 ? [] : [[key, nested]];
    }),
  );
}

// OpenCode 1.18.34 pins this adapter. Its string schema is open-ended, not an enum.
// Source: @ai-sdk/openai-compatible 2.0.41, openai-compatible-chat-language-model.
const compatibleAdapter = {
  package: '@ai-sdk/openai-compatible',
  version: '2.0.41',
  family: 'OpenAI-compatible chat models',
  hostVersion: '1.18.34',
};

function knownAdapter(model: Record<string, unknown>) {
  return record(model.api) && model.api.npm === compatibleAdapter.package ? compatibleAdapter : undefined;
}

export function parameterMetadata(model: unknown, parameters: ModelParameters = {}) {
  const metadata = record(model) ? model : {};
  const capabilities = record(metadata.capabilities) ? metadata.capabilities : {};
  const options = record(metadata.options) ? metadata.options : {};
  const variants = record(metadata.variants) ? Object.values(metadata.variants).filter(record) : [];
  return {
    hostVersion: '1.18.34',
    adapter: knownAdapter(metadata),
    // This verifies host destinations, not every provider adapter's wire support.
    controls: Object.fromEntries(
      controls.map((key) => [
        key,
        {
          destination: `chat.params.${key}`,
          type: key === 'topK' || key === 'maxOutputTokens' ? 'integer' : 'number',
          minimum: key === 'topK' || key === 'maxOutputTokens' ? 1 : 0,
          maximum: key === 'temperature' ? 2 : key === 'topP' ? 1 : Number.MAX_SAFE_INTEGER,
          validation: 'structural',
          support: 'host-verified',
          available:
            (key !== 'temperature' || capabilities.temperature !== false) &&
            (key !== 'topK' || knownAdapter(metadata) === undefined),
        },
      ]),
    ),
    options: Object.fromEntries(
      Object.keys(parameters.options ?? {}).map((key) => [
        key,
        {
          destination: `chat.params.options.${key}`,
          wireDestination:
            knownAdapter(metadata) !== undefined && key === 'reasoningEffort' ? 'reasoning_effort' : undefined,
          validation:
            knownAdapter(metadata) !== undefined && key === 'reasoningEffort' ? 'adapter-verified' : 'structural',
          support: 'provider-unverified',
          catalog: Object.hasOwn(options, key) || variants.some((variant) => Object.hasOwn(variant, key)),
        },
      ]),
    ),
  };
}

export function filterParameters(parameters: ModelParameters, model: unknown): ModelParameters {
  const result = parseParameters(parameters);
  const metadata = record(model) ? model : {};
  const capabilities = record(metadata.capabilities) ? metadata.capabilities : {};
  if (capabilities.temperature === false) {
    delete result.temperature;
  }
  if (knownAdapter(metadata) !== undefined) {
    delete result.topK;
    if (
      result.options !== undefined &&
      Object.hasOwn(result.options, 'reasoningEffort') &&
      typeof result.options.reasoningEffort !== 'string'
    ) {
      throw new SettingsError('The OpenAI-compatible adapter requires reasoningEffort to be a string.');
    }
  }
  const limit = record(metadata.limit) ? metadata.limit.output : undefined;
  if (
    result.maxOutputTokens !== undefined &&
    typeof limit === 'number' &&
    limit > 0 &&
    result.maxOutputTokens > limit
  ) {
    throw new SettingsError('maxOutputTokens exceeds the selected model catalog output limit.');
  }
  return result;
}
