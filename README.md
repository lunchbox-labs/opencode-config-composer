# OpenCode Config Composer

This project is independently maintained. It is not built by the OpenCode team and is not affiliated with
OpenCode or Anomaly.

Compose agent prompts, ordered group defaults, reusable model presets, and inline includes in native skill output.
The TUI provides `/agent-models` and `/agent-groups` for reviewing and saving settings.

The npm package name is **`@lunchbox-labs/opencode-config-composer`**.

The canonical composition format is specified in [the schema contract](docs/composition-schema.md).
`schema.json` describes that format, including components, mixed groups, presets, and named profiles.
The draft server and composition editors consume this format and explicit imports. Native permission
compilation uses the ordered canonical contributions. Unsupported scopes warn and continue with the
fallback described below. Scoped apply and the final integration acceptance suite remain incomplete,
so this branch is not release-ready. The setup examples below describe the preceding released format,
which the canonical server rejects with migration guidance. Use the schema contract for canonical configuration.

The model editor updates only model/reference/variant fields in canonical `componentGroups` and
`configurationPresets`, retaining their permissions, parameters, prompt settings, and component membership.
Imported definitions are edited in their declaring file when it is writable inside the configuration directory;
outside sources and symlink aliases are read-only. All observed sources participate in stale-file checks.
The default shared file is optional when project sources exist; an explicit `configFile` remains required.
Reload checks every source path, including aliases and previously absent project/local scopes, before applying changes.
Previews use the selected profiles and their layer order. Membership changes never activate profiles,
and reordering a membership list does not change profile precedence. Inline and file-backed component agents
and native built-ins are available in the membership picker. Existing project agents from native `opencode.json(c)`
and `.opencode/agent(s)/*.md` sources are included, following the pinned host's project source precedence.
Duplicate Markdown identities within a native directory are rejected: OpenCode's file traversal order
can vary, so keep one definition for each identity before editing.
Project-native sources remain read-only in this editor: JSONC component groups can add memberships without
creating shadow agent files or changing native model pins. Removing native frontmatter/JSON memberships or
changing native pins requires editing the declaring native source. Nested native source paths and aliases
participate in stale-save checks. Composer component definitions still require explicit JSONC imports.

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

## Bundled reference skills

The installed package registers three native skills: `config-composer-explain`, `config-composer-create`,
and `config-composer-migrate`. Load the relevant skill through OpenCode's native skill tool when explaining
settings, creating reusable definitions, or migrating legacy configuration. Each skill includes relative
reference files or validated examples in the package. No personal skill installation is required.

The bundle uses a module-relative native skill directory, preserves existing skill paths and URLs, and
does not inject bodies into agent prompts or change skill permissions. Native permissions can deny loading
these skills. The guidance remains available when Composer source validation fails, so migration and repair
help can load without applying invalid profile fields. Missing or malformed package resources produce a diagnostic directing reinstallation.
The creation example is inactive until selected; the migration example shows an explicit selection needed
to preserve its illustrated legacy behavior. Substitute actual model IDs and retain native files.
This uses native on-demand loading; automatic Composer directory discovery and a custom lazy loader
remain outside this feature.

## Settings editor

Use `/compose` to open the composition hub. It links the model and membership editors and a read-only
saved preview of active profiles, replay order, resolved fields, source paths, references, and overwritten
origins. Back and Escape return across sections; `/agent-models` and `/agent-groups` remain available.
The preview distinguishes saved composition from the running configuration and session model selections.
Ordered permission contributions, compiled policies, native origins, and compilation warnings are inspectable.

The prompt screen selects an explicit writable JSONC source and target, then edits ordered multiline
prepend/append fragments. Fragments can contain include markers or a complete `@source/file.md` shorthand.
Effective prompt provenance lists the authored base, contributing fragment pointers, reusable prompt
definitions, inheritance controls, and included files; unavailable native origins stay explicit.
Agent components and explicit agent overrides also expose `inheritDefaults` and `inheritGroups` controls.
Removing a local operation or resetting prompt settings preserves earlier contributions and the authored
base body. Prompts without an authored native body remain native. The confirmation shows affected authored
prompts and included file paths; reload remains explicit.

Prompt previews use pending file edits when a snippet is also an edited source. Included files, including
newly activated references, are captured once per canonical path and checked again before writes. A changed
file or redirected alias requires reopening the editor. Invalid or missing includes are rejected even for
an inactive prompt target.

The prompt-source screen creates, edits, renames, and deletes reusable `components.prompts` and
`sourceDirectories` aliases. New definitions require an explicit JSONC destination. Existing definitions
show their declaring file; relative paths keep that origin, including definitions imported from another
directory. Prompt bodies can be multiline text or an explicit file. Composer agent components can append,
reorder, repeat, remove, and reset their `promptRefs` without replacing their base prompt.

Renames review known loaded consumers and update writable JSONC references; referenced deletion is rejected.
Alias references in retained Markdown/native bodies or nested snippets must first be changed in their
own declaring source. Reference inspection covers loaded definitions, declared component files, native agent
bodies, and their nested includes; it does not scan directories for additional consumers. Escaped literal
include markers are preserved. New files and directory identities are captured through confirmation so
changed content or redirected aliases abort before writes, including inactive definitions. A corrected alias
path is validated against the proposed directory. Built-in bodies and native skill files are not rewritten.

`/compose` also provides **Repair invalid memberships** when an active group names an unavailable or disabled
agent, a missing skill/command/prompt member, or a native agent names an undefined group. The repair screen
retains the saved diagnostic and source locations without presenting an effective configuration for invalid
input. Accumulate edits to several group member lists, define a missing group in an explicit writable JSONC
source, or choose a shared/project/local profile selection. Read-only definitions may instead be deactivated
through an explicit writable selection scope. Native definitions and bodies are retained.

Review validates the complete candidate before any file is saved; an incomplete repair remains in the draft.
Saving rechecks source freshness, native baseline, catalogs, project authorization, and newly referenced files.
Apply still requires an explicit reload. This recovery path covers membership resolution in otherwise valid
sources. Malformed JSONC/frontmatter, missing imports, invalid profile/preset references, and cycles retain their
specific validation errors and must be corrected in the named source before this editor can inspect them.
If native inputs disagree after instance-only disposal, restart or fully reload the server before repair.
The pinned host can retain globally cached agent fields across instance disposal; the editor rejects that
ambiguous baseline rather than guessing which saved values were native.

The permission editor selects a writable source and configuration target, then adds, edits, removes,
and reorders `{tool, pattern, action}` rules. Repeated rules remain ordered. A blank pattern matches all
inputs; actions are `allow`, `ask`, or `deny`. Removing local rules or saving an empty list leaves earlier
contributions available. Permission-only presets can be created without a model binding and remain inactive
until explicitly selected through a profile layer.

Configured match previews can inspect one definition or an active agent's complete contribution sequence.
They identify the latest matching rule and its source, including earlier matching candidates. A later
`allow` can replace an earlier `deny`; a later nonmatch leaves the earlier match intact. No Composer match
defers to native permissions without guessing their action. These previews describe configured contributions;
native defaults and remembered session approvals can change the effective result. Saves preserve the running
configuration until explicit Reload. Review includes any compilation warning for the candidate.

Global rules use `defaults.permissions` and `overrides.permissions`. Active profile `overrides.permissions`
replay in profile order between scoped defaults and scoped overrides. `defaults.agents.permissions` applies
only to selected agents. Agent contributions compile after the applied global policy and native agent rules.
An unmatched contribution retains those fallbacks. Compiled provenance retains authored array pointers,
including for generated wildcard keys; failed scopes retain native origins.

Unsupported native ordering or a rule shape that the pinned host cannot express skips **all Composer
permission contributions for that scope**. An affected agent retains its native permission object and the
successfully applied global policy. An affected global scope retains native global permissions; independent
agent policies still compile. Models, prompts, commands, skills, and other valid policies continue to apply.
Fallback can be more permissive and omit intended deny rules. Composer does not alter session rules or
introduce additional tool blocking. Use concrete tool names to resolve unsupported wildcard interleaving.

Warnings name the scope, source paths, JSON pointers, conflict, and fallback. They appear on stderr and as
native TUI toast events. Startup delivery is nonblocking. Active warnings replay when an affected session is
used; identical warnings are deduplicated per instance/session, with change and recovery notifications.
Reload starts a new instance and may repeat an active warning. A failed notification transport does not
prevent other settings from applying; stderr remains available to headless clients.

The hub's definition editor creates, renames, and deletes component groups, configuration presets, and profiles.
New definitions require an explicit existing writable JSONC destination and do not activate profiles.
Group member pickers cover agents, skills, commands, and prompt fragments; profile editors manage parent
profiles and ordered group/preset layers. Renames update schema references and native JSON/frontmatter
group memberships, retaining source comments and Markdown bodies. Referenced deletion and renames that
would change read-only sources are rejected before writes. Native memberships supplied through environment
or file substitutions must be changed at their declaring source before rename or deletion. Model controls
reuse the existing picker.

Previews use the server's uncomposed native model and agent baseline, including native config-content inputs.
Clearing a profile override therefore restores the native fallback, including `opencode:model` references.
The matching Composer server plugin must be loaded. Different client/server native agent inputs or later
plugin changes block editing with reload guidance. Runtime baseline metadata is never written to source files;
reload accepts saved native edits that have not yet reached the running server.

The activation screen explicitly selects shared, project, or local scope. An ordered local list replaces
an earlier selection; an absent key inherits, and an empty list selects no profiles. Later explicit
selections are shown as masking earlier scopes. Saving never deletes conversations; reload remains explicit.
Missing fixed scope files can be created as new JSONC destinations, including the first optional source.
With no optional sources, the server preserves native configuration and publishes the editor baseline;
explicitly configured missing files and malformed sources still fail validation.
New files are published without replacing concurrent files, and project writes require their own shared
filesystem check. Native project agent files and external imports remain read-only.

The parameter screen selects an explicit source and configuration target before editing `temperature`,
`topP`, `topK`, `maxOutputTokens`, or custom provider options as JSON. Targets include scoped agent defaults,
groups, presets, component agents, and scoped/profile agent overrides. Blank input removes one local field;
reset removes the local parameter object so earlier contributions can apply. Saves retain model bindings
and sibling settings. The review shows effective parameters for changed active consumers; later contributions
and native pins can mask an edit.

Provider catalog capabilities and output limits reject known unsupported controls before saving. Model
changes revalidate retained parameters. Custom options are structurally checked; the pinned OpenAI-compatible
adapter additionally checks the type of `reasoningEffort`, while other options remain provider-unverified.
Inactive profile references to native model slots defer model-dependent checks until activation supplies
their effective model context. Reload applies saved parameters; native agent settings and selected variants
retain their precedence at dispatch.

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
