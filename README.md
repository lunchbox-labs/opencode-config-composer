# OpenCode Config Composer

This project is independently maintained. It is not built by the OpenCode team and is not affiliated with
OpenCode or Anomaly.

Compose agent prompts, ordered group defaults, reusable model presets, and inline includes in native skill output.
The TUI provides `/agent-models` and `/agent-groups` for reviewing and saving settings.

The npm package name is **`@lunchbox-labs/opencode-config-composer`**.

Supported and tested host: **OpenCode V1 1.18.34**. The `opencode` engine requirement is intentionally exact.
Broaden it only after checking another host version. This package does not implement a V2 port.
Development requires Node 22.18 or newer and npm. Compiled runtime files do not require TypeScript or OpenTUI packages.
Host types and OpenTUI dependencies are development-only; the host supplies the TUI API.

## Use a local build

```sh
npm ci
npm run build
npm pack
```

Use the tarball filename printed by `npm pack`.
Install it in a separate local directory with `npm install /absolute/path/to/package.tgz`.
Register its **installed package directory** in each configuration file. Replace `/absolute/path/to/installed-package`:

`opencode.jsonc`:

```jsonc
{
  "plugin": ["/absolute/path/to/installed-package"]
}
```

`tui.jsonc`:

```jsonc
{ "plugin": ["/absolute/path/to/installed-package"] }
```

Preserve other plugin entries. Register exactly one Composer server and one Composer TUI entry.
For a registry installation, replace the directory in both files with `@lunchbox-labs/opencode-config-composer@VERSION`.
Replace `VERSION` with the published version. Use the same specifier in both files; OpenCode selects `./server` or `./tui`.
The root export also supplies the server module for direct JavaScript imports.

## Settings and paths

Create `config-composer.jsonc` in the OpenCode configuration directory:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/lunchbox-labs/opencode-config-composer/main/schema.json",
  "sourceDirectories": { "shared": "./prompts" },
  "agent": {
    "modelPresets": { "balanced": { "model": "provider/model-id", "variant": "medium" } },
    "groups": {
      "developers": { "modelRef": "preset:balanced", "prompt": { "append": ["Check your changes."] } },
      "reviewers": { "modelRef": "opencode:model" }
    },
    "prompts": {
      "defaults": { "append": ["{{include:@shared/common.md}}"] },
      "overrides": { "reviewer": { "inheritDefaults": false, "prepend": ["Review carefully."] } }
    }
  },
  "command": {},
  "skill": {}
}
```

Use real provider model IDs and supported variants. The example values are placeholders.
The authoritative [schema](schema.json) is hosted at the raw GitHub URL above, tracking `main`.
For an installed-version schema, use `"$schema": "./node_modules/@lunchbox-labs/opencode-config-composer/schema.json"`
when `node_modules` is beside your settings, or adjust the relative path. A copied schema can use `"$schema": "./schema.json"`.
JavaScript consumers can import the supported `@lunchbox-labs/opencode-config-composer/schema.json` subpath with `{ type: "json" }` import attributes.

The server loads `config-composer.jsonc` by default. To select another file, use a plugin options tuple:

```jsonc
{
  "plugin": [["/absolute/path/to/installed-package", { "configFile": "settings/custom.jsonc" }]]
}
```

- The default filename and a relative `configFile` resolve from `OPENCODE_CONFIG_DIR` when set;
  otherwise from the absolute `XDG_CONFIG_HOME/opencode`,
  or `~/.config/opencode`. A relative `OPENCODE_CONFIG_DIR` resolves from the process working directory.
- Relative `sourceDirectories` paths resolve from the **settings file's directory**, never the package directory.
  Absolute paths and `~/` paths are supported.
- The settings editor operates only on the server's local global/custom configuration directory.
  It requires one `opencode.json` or `opencode.jsonc`. Remote configuration editing is unsupported.
  It verifies shared filesystem access through the server's file API before editing or reloading.
  This check creates a temporary random probe in the configuration directory and removes it afterward.
  If the server cannot read that probe, the editor refuses to change settings.
- Settings use the structured file shape above. Plugin options accept only `configFile` and the editor's
  `reloadToken`. Empty options or only `reloadToken` use the default file.
  A missing or invalid settings file is an error.
- Leave `command` and `skill` empty. Their group settings are reserved; native skill includes use `sourceDirectories`.

## Composition behavior

Assign ordered groups in an agent's Markdown frontmatter or native agent configuration:

```yaml
groups: [developers, reviewers]
```

Later groups override earlier model fields. An explicit agent model remains pinned.
An explicit agent variant can override an inherited variant. Unsupported referenced variants fail at dispatch.
Agent membership uses ordered `groups` arrays.
A group may use a concrete `model`, `preset:NAME`, `opencode:model`, or `opencode:small_model`.
Native references resolve against effective workspace defaults, including project overrides.
Missing presets and unset native references are errors. Presets cannot reference other presets.

Prompt order is: default prepend, ordered group prepend, agent prepend, authored body,
default append, ordered group append, agent append. Agent overrides can disable inherited defaults or groups.
Built-in agents without authored prompts retain their native prompts. Disabled agents are not composed.
Repeated configuration hooks do not accumulate guidance; reload rereads source fragments.

Use `{{include:@shared/path.md}}` in authored agent prompts, composition fragments, or native skill bodies.
Includes can nest. Escape a literal directive with a preceding backslash.
Native skill composition preserves the tool's wrapper, metadata, resources, and base directory.
It does not apply agent prepend/append layers to skills. Truncated skill output is rejected before composition.
Command composition is not implemented.

Includes accept contained `.md` and `.txt` UTF-8 files. Unsafe paths, escaping symlinks, cycles, invalid text,
and excessive depth or size are rejected. Limits are 64 KiB per snippet, 256 KiB per composed prompt,
32 include levels, and 256 include expansions. Settings files have a 1 MiB limit.

## Settings editor

Use `/agent-models` for global defaults, presets, groups, and individual overrides.
Use `/agent-groups` for ordered memberships. Model and variant choices come from the provider API.
Review the proposed scope and retained pins before saving. The editor preserves prompts, comments,
unrelated settings, and permissions. Stale snapshots, concurrent edits, and symlinked settings are rejected.

Reload is explicit. It invalidates configuration in **all workspaces on the server**.
Wait for all agents to finish first; the editor can check activity only in the current workspace.
Saved changes can instead take effect at restart. A current session's selected model may still take precedence.
Nested dialogs retain Back/Escape navigation without reopening after lifecycle or route changes.

## Development and checks

```sh
npm ci
npm run check
OPENCODE_BIN=/absolute/path/to/opencode npm run test:native
```

`check` runs type checking, strict ESLint, formatting, unit/TUI tests, and an isolated tarball installation.
The package check installs production dependencies only and tests server/TUI exports,
path resolution, and rejected internal imports outside the checkout. Unit tests cover package-name recognition,
settings edits, reload tokens, TUI callbacks, and navigation.
The package check also compiles installed declarations and rejected imports with `skipLibCheck: false`.
TypeScript consumers need OpenCode's plugin/SDK and OpenTUI development types, as pinned in this repository.
With TypeScript 6, include `"types": ["node"]` in the consumer's `compilerOptions`.
These types are not runtime dependencies. Normal OpenCode configuration files need no TypeScript imports.
`test:native` requires Python 3 and a Unix pseudo-terminal. It verifies the selected binary's version against
`engines.opencode`, then loads an installed tarball in the native server and TUI.
It checks prompt/group composition, native skill includes, dispatch, live reload, and both rendered Composer menus.
The checks use a synthetic local provider without credentials or paid calls.

`engines.opencode` is the authoritative CLI baseline. CI installs that exact binary through `scripts/opencode.mjs`.
The script checks the independently pinned plugin and SDK libraries against `package-lock.json`.
Library versions describe the development types. Compatibility is verified with the actual CLI and installed package.

TUI navigation helpers are included under `src/tui/`.
The tarball includes compiled modules, declarations, schema, license, TypeScript source, and build configuration.
It excludes tests, CI workflows, maintainer tooling, and credentials.

## Package entrypoints

OpenCode loads the plugin through these entrypoints. Server and TUI imports each expose only their default plugin descriptor:

| Export | Purpose |
| --- | --- |
| `@lunchbox-labs/opencode-config-composer` or `@lunchbox-labs/opencode-config-composer/server` | Server plugin module |
| `@lunchbox-labs/opencode-config-composer/tui` | TUI plugin module |
| `@lunchbox-labs/opencode-config-composer/schema.json` | Settings JSON schema |

The package provides no executable command. `exports` defines the supported import surface.
Settings, configuration, storage, navigation, and package metadata subpaths are not exported.
Published source and runtime files remain inspectable. Export restrictions are an API boundary, not a secrecy control.

## License

This project is licensed under MIT. See [LICENSE](LICENSE).
