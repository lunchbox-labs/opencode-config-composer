import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import { visit } from 'jsonc-parser';
import schema from '../../../schema.json' with { type: 'json' };
import { MAX_CONFIGURATION_BYTES, parseConfiguration } from '../configuration.ts';
import { SettingsError, record } from '../settings.ts';
import type { CompositionDiagnostic } from './types.ts';
import type { CompositionDocument } from './document-types.ts';

// Validate against the published schema, rather than maintaining a second set of field rules.
const validate = new Ajv2020({
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
}).compile<CompositionDocument>(schema);
const migration: Record<string, string> = {
  agent:
    'Move agent definitions to components.agents, groups to componentGroups, modelPresets to configurationPresets, and prompt defaults/overrides to defaults.agents.prompt / overrides.agents.<name>.prompt.',
  command: 'Move command definitions to components.commands.',
  skill: 'Move skill definitions to components.skills.',
  groups: 'Move group memberships and settings to componentGroups; activate them through profiles.',
  modelPresets: 'Move reusable settings to configurationPresets and assign them with targeted profile layers.',
  promptSources: 'Move source aliases to sourceDirectories and named prompt files to components.prompts.',
  promptDefaults: 'Move shared prompt operations to defaults.agents.prompt.',
  agentPrompts: 'Move per-agent prompt operations to overrides.agents.<name>.prompt.',
  model: 'Move the runtime model default to defaults.model.',
  small_model: 'Move the small runtime model default to defaults.small_model.',
  composition:
    'Move the profile into the named profiles registry; use imports for its document and names for extends / activeProfiles.',
  extends:
    'Move the profile into the named profiles registry; use imports for its document and a profile name for extends.',
};

function pointerPart(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

export class CompositionValidationError extends SettingsError {
  readonly diagnostic: CompositionDiagnostic;

  constructor(diagnostic: CompositionDiagnostic) {
    super(`${diagnostic.sourceId ?? 'Composition document'}${diagnostic.pointer ?? ''}: ${diagnostic.message}`);
    this.diagnostic = diagnostic;
  }
}

function fail(code: string, message: string, sourceId?: string, pointer = ''): never {
  throw new CompositionValidationError({ code, message, sourceId, pointer });
}

function copyJson(value: unknown, sourceId?: string, pointer = '', depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'object') {
    fail('invalid-json-value', 'Use only JSON values and finite numbers.', sourceId, pointer);
  }
  if (depth >= 32) {
    fail('composition-limit', 'Use at most 32 levels of objects and arrays.', sourceId, pointer);
  }
  if (Array.isArray(value)) {
    return Array.from(value, (child: unknown, i) => copyJson(child, sourceId, `${pointer}/${i}`, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail('invalid-json-value', 'Use plain JSON objects.', sourceId, pointer);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      const at = `${pointer}/${pointerPart(key)}`;
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        fail('unsafe-composition-key', 'Rename this unsafe object key.', sourceId, at);
      }
      return [key, copyJson(child, sourceId, at, depth + 1)];
    }),
  );
}

function diagnosticError(value: unknown, errors: ErrorObject[]): ErrorObject | undefined {
  const relevant = errors.filter((error) => {
    if (error.keyword === 'oneOf' || error.keyword === 'anyOf') {
      return false;
    }
    // AJV visits both layer alternatives. Do not suggest switching away from the authored branch.
    if (error.keyword === 'required' && /^\/profiles\/[^/]+\/layers\/\d+$/.test(error.instancePath)) {
      let layer: unknown = value;
      for (const part of error.instancePath.slice(1).split('/')) {
        const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
        layer = Array.isArray(layer) ? layer[Number(key)] : record(layer) ? layer[key] : undefined;
      }
      if (record(layer)) {
        const missing: unknown = error.params.missingProperty;
        if (
          (missing === 'componentGroup' && Object.hasOwn(layer, 'configurationPreset')) ||
          (missing === 'configurationPreset' && Object.hasOwn(layer, 'componentGroup'))
        ) {
          return false;
        }
      }
    }
    return true;
  });
  // A leaf diagnostic identifies the actual invalid value instead of its union wrapper.
  return relevant.toSorted((left, right) => right.instancePath.length - left.instancePath.length)[0] ?? errors[0];
}

/** Validate one document without loading imports or resolving cross-document names. */
export function readCompositionDocument(value: unknown, sourceId?: string): CompositionDocument {
  const copied = copyJson(value, sourceId);
  if (Buffer.byteLength(JSON.stringify(copied), 'utf8') > MAX_CONFIGURATION_BYTES) {
    fail('composition-limit', 'Keep each composition document no larger than 1 MiB.', sourceId);
  }
  if (record(copied)) {
    for (const key of Object.keys(copied)) {
      if (Object.hasOwn(migration, key)) {
        fail(
          'legacy-composition-key',
          `${migration[key]} Legacy composition keys are not supported.`,
          sourceId,
          `/${key}`,
        );
      }
    }
  }
  if (!validate(copied)) {
    const error = diagnosticError(copied, validate.errors ?? []);
    // propertyNames reports its key on a sibling wrapper error, not on the selected leaf error.
    const propertyName: unknown = validate.errors?.find(
      (item) => item.keyword === 'propertyNames' && item.instancePath === error?.instancePath,
    )?.params.propertyName;
    const extra: unknown = error?.params.additionalProperty ?? propertyName;
    const pointer = `${error?.instancePath ?? ''}${typeof extra === 'string' ? `/${pointerPart(extra)}` : ''}`;
    if (pointer.startsWith('/activeProfiles') || /^\/profiles\/[^/]+\/extends$/.test(pointer)) {
      fail(
        'invalid-profile-selection',
        'Use unique profile names (up to 64 lowercase letters, digits, and hyphens), not file paths. Declare files in imports and definitions in profiles; activeProfiles is an ordered list of at most 64 names and extends is one name.',
        sourceId,
        pointer,
      );
    }
    fail(
      'invalid-composition-document',
      `Fix this field: ${error?.message ?? 'invalid composition document'}. See schema.json for supported fields and limits.`,
      sourceId,
      pointer,
    );
  }
  return copied;
}

export function parseCompositionDocument(text: string, sourceId?: string): CompositionDocument {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIGURATION_BYTES) {
    fail('composition-limit', 'Keep each composition document no larger than 1 MiB.', sourceId);
  }
  // Stop before the JSONC parser or duplicate-key walk can recurse beyond our contract.
  let depth = 0;
  function begin(): void {
    if (++depth > 32) {
      fail('composition-limit', 'Use at most 32 levels of objects and arrays.', sourceId);
    }
  }
  function end(): void {
    depth--;
  }
  visit(text, {
    onObjectBegin: begin,
    onArrayBegin: begin,
    onObjectEnd: end,
    onArrayEnd: end,
    onObjectProperty(key, _offset, _length, _line, _character, path) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        fail(
          'unsafe-composition-key',
          'Rename this unsafe object key.',
          sourceId,
          `/${[...path(), key].map((part) => pointerPart(String(part))).join('/')}`,
        );
      }
    },
  });
  try {
    return readCompositionDocument(parseConfiguration(text), sourceId);
  } catch (error) {
    if (error instanceof CompositionValidationError) {
      throw error;
    }
    if (error instanceof SettingsError) {
      fail('invalid-composition-jsonc', error.message, sourceId);
    }
    throw error;
  }
}

/** Inputs are validated documents. Preserve absence until the selection boundary. */
export function selectActiveProfiles(shared?: CompositionDocument, local?: CompositionDocument): string[] {
  return [...(local?.activeProfiles ?? shared?.activeProfiles ?? [])];
}
