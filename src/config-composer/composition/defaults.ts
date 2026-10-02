import type { NativeInput } from './types.ts';

export function resolveNativeDefaults(
  native: NativeInput,
  composer: { model?: string; small_model?: string },
): Pick<NativeInput, 'model' | 'small_model'> {
  const model = composer.model ?? native.model;
  const small = composer.small_model ?? native.small_model;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(small !== undefined ? { small_model: small } : {}),
  };
}
