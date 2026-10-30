import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { SettingsError, record } from '../settings.ts';
import type { ConfigurationConnection } from '../storage.ts';
import { type AttestedRuntime, configFields, metadata, readLoadedRuntime } from '../composition/runtime-baseline.ts';
import { builtins } from '../composition/runtime.ts';

/** A server read, independent of local definition/selection files and mutation proofs. */
export async function loadInspection(api: TuiPluginApi, connection: ConfigurationConnection) {
  const client = api.client;
  const directory = connection.location.directory;
  const [config, agents, commands] = await Promise.all([
    connection.config(),
    client.app.agents({ directory }),
    client.command.list({ directory }),
  ]);
  connection.assertCurrent();
  if (!record(config) || agents.error !== undefined || commands.error !== undefined) {
    throw new SettingsError('Could not read the current server configuration.');
  }
  let runtime: AttestedRuntime | undefined;
  try {
    runtime = readLoadedRuntime(config, connection.location);
  } catch {
    // Native values remain inspectable when Composer attribution is unavailable.
  }
  return {
    config: metadata(configFields(config)),
    agents: agents.data,
    commands: commands.data,
    runtime,
  };
}
export type Inspection = Awaited<ReturnType<typeof loadInspection>>;

export function inspectionAgents(snapshot: Inspection, showBuiltins: boolean): string[] {
  const agents = new Map(snapshot.agents.map((agent) => [agent.name, agent]));
  return [...new Set([...agents.keys(), ...Object.keys(snapshot.config.agent ?? {})])]
    .filter((name) => showBuiltins || !(agents.get(name)?.native ?? Object.hasOwn(builtins, name)))
    .sort();
}

/** Slot reads must preserve the host Solid proxy; never clone api.state.config. */
function loadedMarker(config: unknown, directory: string, root: string): Record<string, unknown> | undefined {
  if (!record(config) || !Array.isArray(config.plugin)) {
    return;
  }
  for (const entry of config.plugin) {
    if (!Array.isArray(entry) || !record(entry[1])) {
      continue;
    }
    const marker = entry[1].__configComposerRuntime;
    if (
      record(marker) &&
      marker.version === 2 &&
      record(marker.location) &&
      marker.location.directory === directory &&
      marker.location.root === root
    ) {
      return marker;
    }
  }
}
export function appliedProfile(config: unknown, directory: string, root: string): string | undefined {
  const marker = loadedMarker(config, directory, root);
  if (
    marker === undefined ||
    marker.status !== 'applied' ||
    !record(marker.revision) ||
    typeof marker.revision.effective !== 'string' ||
    !record(marker.candidate)
  ) {
    return;
  }
  const profile = marker.candidate.profile;
  return profile === null ? 'Shared only' : typeof profile === 'string' ? profile : undefined;
}
/** The diagnostic the server published when its config hook failed for this location. */
export function runtimeDiagnostic(config: unknown, directory: string, root: string): string | undefined {
  const marker = loadedMarker(config, directory, root);
  return marker !== undefined && marker.status === 'error' && typeof marker.diagnostic === 'string'
    ? marker.diagnostic
    : undefined;
}
