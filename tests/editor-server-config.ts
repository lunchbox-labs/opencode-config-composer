import type { Config as PluginConfig } from '@opencode-ai/plugin';
import type { Config as NativeConfig } from '@opencode-ai/sdk/v2';
type Config = PluginConfig & Pick<NativeConfig, 'default_agent'>;
import { publishRuntimeBaseline } from '../src/config-composer/composition/runtime-baseline.ts';
import { packageName } from '../src/config-composer/package-name.ts';
import type { NativeModels } from '../src/config-composer/settings.ts';
import { loadSnapshot } from '../src/config-composer/storage.ts';
import { compositionRevision, observeNativeFiles } from '../src/config-composer/composition/revision.ts';

/** Model the public config hook response, including its uncomposed native baseline. */
export async function editorServerConfig(
  directory: string,
  native: NativeModels,
  workspace = directory,
  currentDirectory = workspace,
  worktree = workspace,
): Promise<Config> {
  const snapshot = await loadSnapshot(
    directory,
    workspace,
    { model: native.model, small_model: native.small_model, default_agent: native.default_agent },
    currentDirectory,
    worktree,
  );
  const config: Config = {
    plugin: [packageName],
    model: snapshot.resolved.model,
    small_model: snapshot.resolved.small_model,
    default_agent: snapshot.resolved.default_agent,
  };
  publishRuntimeBaseline(config, {}, { root: workspace, directory: currentDirectory }, native, snapshot.nativeAgents, {
    revision: compositionRevision(snapshot.sources, snapshot.resolved, snapshot.files),
    observedNativeFiles: await observeNativeFiles(directory),
  });
  return config;
}
