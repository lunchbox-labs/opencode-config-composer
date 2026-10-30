import { record } from '../settings.ts';
import type { NativeAuthority, ResolvedCandidate } from './document-types.ts';

interface Request {
  agent: string;
  model: {
    providerID: string;
    id: string;
    api: { npm: string };
    capabilities?: { temperature: boolean };
    variants?: Record<string, Record<string, unknown>>;
  };
  message: { model: { providerID: string; modelID: string; variant?: string } };
}
interface Parameters {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  options: Record<string, unknown>;
}

function mergeOptions(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  protectedValues: unknown[],
): Record<string, unknown> {
  const result = structuredClone(current);
  for (const [key, value] of Object.entries(incoming)) {
    const owners = protectedValues.filter((owner) => record(owner) && Object.hasOwn(owner, key));
    const protectedChildren = owners.map((owner) => (record(owner) ? owner[key] : undefined));
    if (owners.length > 0 && (!record(value) || protectedChildren.some((child) => !record(child)))) {
      continue;
    }
    const previous = Object.hasOwn(result, key) ? result[key] : undefined;
    Object.defineProperty(result, key, {
      value: record(value)
        ? mergeOptions(record(previous) ? previous : {}, value, protectedChildren)
        : structuredClone(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/** Model-specific defaults: never materialized into native agent-wide options. */
export function applyModelParameters(
  candidate: ResolvedCandidate | undefined,
  authority: NativeAuthority,
  input: Request,
  output: Parameters,
): void {
  const bindings = candidate?.modelParameters;
  const binding = Object.hasOwn(bindings ?? {}, input.agent) ? bindings?.[input.agent] : undefined;
  if (binding?.model !== `${input.model.providerID}/${input.model.id}`) {
    return;
  }
  const parameters = binding.parameters;
  const agent = candidate?.agent[input.agent] ?? {};
  if (parameters.temperature !== undefined && !Object.hasOwn(agent, 'temperature')) {
    output.temperature = parameters.temperature;
  }
  if (parameters.top_p !== undefined && !Object.hasOwn(agent, 'top_p')) {
    output.topP = parameters.top_p;
  }
  if (parameters.topK !== undefined) {
    output.topK = parameters.topK;
  }
  if (parameters.maxOutputTokens !== undefined) {
    output.maxOutputTokens = parameters.maxOutputTokens;
  }
  const authored = Object.hasOwn(authority, input.agent) ? authority[input.agent] : undefined;
  if (parameters.options !== undefined && !Object.hasOwn(authored?.fields ?? {}, 'options')) {
    // Native title generation uses a small request and deliberately skips variants.
    const variant = input.agent === 'title' ? undefined : input.message.model.variant;
    const selected =
      variant !== undefined && Object.hasOwn(input.model.variants ?? {}, variant)
        ? input.model.variants?.[variant]
        : undefined;
    output.options = mergeOptions(output.options, parameters.options, [agent.options, selected]);
  }
}
