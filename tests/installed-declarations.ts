import root from '@lunchbox-labs/opencode-config-composer';
import server from '@lunchbox-labs/opencode-config-composer/server';
import tui from '@lunchbox-labs/opencode-config-composer/tui';
import type { PluginModule } from '@opencode-ai/plugin';
import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

const servers: PluginModule[] = [root, server];
const terminal: TuiPluginModule = tui;
void servers;
void terminal;

// @ts-expect-error Only default descriptors are public.
import { ConfigComposerPlugin } from '@lunchbox-labs/opencode-config-composer';
// @ts-expect-error Server helper aliases are not public.
import { AgentGroupsPlugin } from '@lunchbox-labs/opencode-config-composer/server';
// @ts-expect-error Host types must come from the host package.
import type { Plugin } from '@lunchbox-labs/opencode-config-composer/server';
// @ts-expect-error TUI registration helpers are not public.
import { registerSettings } from '@lunchbox-labs/opencode-config-composer/tui';
import schema from '@lunchbox-labs/opencode-config-composer/schema.json' with { type: 'json' };
const schemaType: string = schema.type;
void schemaType;
// @ts-expect-error Package metadata is not public.
import manifest from '@lunchbox-labs/opencode-config-composer/package.json';
// @ts-expect-error Internal compiled modules are not public.
import storage from '@lunchbox-labs/opencode-config-composer/dist/config-composer/storage.js';
// @ts-expect-error Source modules are not public.
import settings from '@lunchbox-labs/opencode-config-composer/src/config-composer/settings.ts';
void [ConfigComposerPlugin, AgentGroupsPlugin, registerSettings, schema, manifest, storage, settings];
type RejectedHostType = Plugin;
export type { RejectedHostType };
