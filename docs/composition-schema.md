# Configuration reference

`config-composer.jsonc` uses the package's [schema.json](../schema.json). JSONC comments and trailing commas
are accepted. Duplicate keys, unsafe keys, unknown fields and legacy shapes are rejected with source locations.
See the [complete review/programming example](examples/review-programming) for all component resources,
explicit imports, reusable model and permission presets, and profiles that compose them.

## Document fields

| Field                  | Meaning                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `$schema`              | Optional schema location for your editor; use the schema matching your installed package.                      |
| `components`           | Named `agents`, `skills`, `commands` and `prompts`. A definition alone does not select it.                     |
| `componentGroups`      | Named bundles with any subset of component kinds and optional member-agent `configuration`.                    |
| `configurationPresets` | Reusable model, variant, parameters or permissions, independent of membership.                                 |
| `profiles`             | Named profiles with one optional `extends` parent, ordered `layers`, `agentAvailability` and `overrides`.      |
| `profileShortcuts`     | Named actions with ordered `activeProfiles` and optional `description`.                                        |
| `defaults`             | Runtime `model`, `small_model`, global `permissions` and selected-agent `agents` defaults.                     |
| `overrides`            | Runtime `model`, `small_model`, global `permissions` and `agents` settings keyed by exact selected agent name. |
| `activeProfiles`       | Ordered profile names. Absence inherits; `[]` selects none.                                                    |
| `imports`              | Explicit local `.json` or `.jsonc` definition documents in authored order.                                     |
| `sourceDirectories`    | Named prompt-include directory aliases, relative to their declaring document.                                  |

An agent supplies exactly one `file` or inline `prompt`. Optional fields are `description`, `mode`
(`primary`, `subagent` or `all`), `disable`, `promptRefs`, `skills` and `configuration`.
A command supplies exactly one `file` or inline `template`, and may specify `agent`, `description` and `subtask`.
A prompt supplies exactly one `file` or inline `text`. A skill supplies `file`, pointing to a native `SKILL.md`.
File-backed agents and commands require YAML object frontmatter. Skill files must be named `SKILL.md` with
a frontmatter `name` exactly matching their component key and a string `description`. Prompt files are plain text.

Agent `promptRefs` appends named prompt bodies in order. Agent `skills` records intended on-demand relationships;
it neither injects skill bodies nor grants exclusive access. Agent settings belong in `configuration`.
A group's `prompts` membership alone does not append prompt bodies; configure relationships or prompt operations.
Selected command templates support native variables and Composer includes. Command `agent` targets are explicit.
Native skill composition preserves OpenCode's wrapper, metadata, resources and base directory.

## Agent membership and availability

Group `agents` names resolve against native built-ins, existing custom agents and Composer component agents.
The pinned OpenCode host defines `build`, `plan`, `general`, `explore`, `compaction`, `title` and `summary`.
Use those names directly without shadow definitions. Hidden agents retain their native visibility.
Missing or unavailable explicit group members produce diagnostics rather than creating agents.

Custom Markdown `groups` frontmatter and native `options.groups` provide another membership source;
direct `groups` takes precedence if both exist. Explicit JSONC members retain authored order, then
frontmatter-only members follow in lexical order. Duplicate membership is applied once. Membership does
not activate a profile; settings precedence comes from profile layer order.

A profile's `agentAvailability` maps names to booleans. Parent decisions replay before child decisions;
later active-profile decisions win. Absence inherits the earlier/native decision. `true` can select a
Composer agent before the profile's layers; `false` retains its definition and settings while disabling it.
Unknown names and internal `compaction`, `title` and `summary` targets are rejected. Maintain at least
one visible enabled primary agent and keep an explicitly configured native default agent enabled.
Switching preserves conversations. If their previous agent is unavailable, choose an enabled continuation agent.

## Profiles and model settings

Each layer either selects a `componentGroup`, or names a `configurationPreset` with a required `target`.
Targets may contain `agents`, `componentGroups`, or both. Group targets expand to their available agent members;
the group itself need not previously have been selected, but those agents must already be selected.
Preset assignment does not select components. Unknown references and unselected targets are errors.
Each profile extends at most one named parent. References are names, not file paths. Parent cycles are rejected.

Each profile switch rebuilds configuration from the original native/base values and shared, project and local
defaults. Replay the destination profiles left to right, with each full parent chain before that profile's layers
and overrides. Old-profile-only settings are removed even when the resolved model is unchanged. Base values
remain where the destination supplies no override. Shared parents replay again on each occurrence:
A and B extending Base produce Base → A → Base → B. Shared, project and local document overrides apply last.
Ordinary objects merge by field and ordinary arrays replace within merged values. Parent and child layer arrays
replay separately. Duplicate definitions are rejected; defaults and overrides express deliberate settings changes.

A preset accepts `model` or `modelRef` (never both), optional `variant`, `parameters` and `permissions`.
An agent/group configuration additionally accepts `prompt`. Presets cannot contain component membership or
prompt operations. Model references are `opencode:model`, `opencode:small_model` or `preset:NAME`.
Native references resolve against final effective workspace defaults; model preset reference cycles are rejected.
Referencing a preset's model settings does not also apply its permissions; use a targeted preset layer for those.

Native authored agent model/variant pins take precedence over defaults and group/preset layers. A component
configuration pins its model only when it supplies `model` or `modelRef`. Explicit per-agent overrides can
replace pins. Partial parameters bind to the effective model and dispatch only for that model; selecting
another model in a session retains native model settings. Within one ordered replay, changing the resolved
model or authored model reference clears inherited Composer variant/parameters, even if the resolved model is
unchanged. Unchanged bindings and parameter-only layers retain earlier contributions. Omitted values fall back
to native settings or remain unset. This retention does not carry settings from a previously active profile selection.
Model editor saves retain authored parameters and validate them for their resulting model binding.

`parameters` supports `temperature` (0–2), `topP` (0–1), positive safe integer `topK` and `maxOutputTokens`,
and an `options` object containing JSON values. Structural validity does not imply provider support;
catalog and adapter validation also run before dispatch. Native temperature/top-p and variant authority is retained.

## Prompt composition and includes

Agent `prompt` configuration supports `prepend` and `append` string arrays, plus `inheritDefaults` and
`inheritGroups`. Assembly order is default prepend, ordered group prepend, agent prepend, authored body,
default append, ordered group append, agent append. Setting an inheritance flag to false suppresses that
inherited prompt layer. Built-ins without an authored prompt retain native prompts.

Use `{{include:@alias/path.md}}` under a `sourceDirectories` alias. Files may contain nested includes;
a preceding backslash escapes a literal directive. Relative aliases and component paths resolve from the
declaring document. Includes accept contained `.md` or `.txt` UTF-8 files. Unsafe paths, escaping symlinks,
cycles, invalid text and excessive content are rejected. Limits are 64 KiB per snippet, 256 KiB per composed
prompt, 32 include levels and 256 expansions. Truncated native skill output is rejected before composition.

Declared component files are read and validated during resolution even when their profiles are inactive.
Native skills remain available for OpenCode's on-demand loading. A custom lazy prompt loader is feasibility
research, not a production capability. Loaded text is not guaranteed permanent context after compaction.

## Permission ordering and fallback

A permission rule has `tool`, optional `pattern` (default `*`), and `action`: `allow`, `ask` or `deny`.
Repeated and overlapping rules are valid. **The latest matching Composer contribution wins, even when looser.**
Authored rule order and contribution order matter; specificity and denial have no automatic priority.
A later nonmatch leaves an earlier match intact. Partial object merges retain earlier nonmatching rules for
fields the later object does not replace. Rule arrays replace inside definitions, while separately replayed
layers retain their ordered contributions. Explicit `ask` is a match; no Composer match uses native fallback.

Global rules replay scoped `defaults.permissions`, active-profile `overrides.permissions`, then scoped
`overrides.permissions`, each in its own scope/profile order. They apply without selecting an agent.
`defaults.agents.permissions` affects selected agents. Agent rules replay scoped defaults, component configuration when the agent is first selected, profile
group/preset layers and profile per-agent overrides, followed by scoped per-agent overrides. Native compilation places agent contributions
after applied globals and native agent permissions. Unmatched requests use native globals and native defaults,
with the host retaining its native agent policy and remembered approvals.

A sequence denying Git, allowing every tool/target, then asking for npm allows Git and asks for npm.
The last npm nonmatch does not restore the older Git deny. Removing the broad allow restores the Git deny.
The [complete example](examples/review-programming/profiles.jsonc) also shows a later reviewer Git allow
leaving an earlier npm denial intact.

If native policy cannot faithfully represent an affected scope, Composer skips **all** Composer permission
contributions for that scope and warns with affected sources. An affected agent retains native agent permissions
plus the applied global policy. An affected global scope retains native globals and allows independent agent
scopes to compile. Other settings continue. **This fallback can be more permissive, including omitting an intended
denial.** Composer does not impose fail-closed behavior or session-permission overlays.

Warnings are shown before reviewed writes, emitted to stderr and native TUI notifications, repeated on affected
session use, and updated when policies change or recover. A configured preview reports the matched Composer
action and origin, or native fallback for a nonmatch; it does not invent an `ask` or Composer source.

## Files, imports and activation

Sources are the shared configured/default file, project `.opencode/config-composer.jsonc`, then local
`.opencode/config-composer.local.jsonc`. Missing optional scope files are allowed; an explicitly requested
missing file or a malformed/unreadable file is an error. The highest scope supplying `activeProfiles` replaces
earlier selections. Omission inherits; `[]` activates no profiles while document defaults/overrides still apply.

Imports load explicit definition documents in authored order. They may define components, groups, presets,
profiles, shortcuts and source directories, but cannot supply root activation/default/override scopes.
Importing never activates profiles. Paths retain the declaring reference directory, including alias-relative
paths. Canonical file identities detect cycles and repeated imports; aliases are read-only for editing.
Duplicate registry names identify both source locations. Automatic directory discovery remains deferred.

Shape validation precedes assembly, so references may point into another imported document. After assembly,
references, model bindings, profile cycles and selected targets are checked before runtime changes.
Per-document limits include 1 MiB of text, 32 JSON container levels, 64 import entries and active profile names,
256 entries in ordinary ordered lists and agent/preset permission arrays, 1,024 rules in global permission arrays,
and 1,024 definitions per registry. Parent and model-reference chains are limited to 32 levels. Across sources,
aggregate document text is limited to 8 MiB and shortcut definitions to 128.

Use `/compose` to review scope, sources and effects before saving. Imported sources outside the configuration
directory and native project sources are read-only. Comments and unrelated fields are preserved; stale snapshots,
changed paths and symlinked write targets are rejected. Saving does not automatically apply changes.
Explicit apply checks current-instance activity, rechecks inputs and verifies the running revision after
rebootstrap. Other instances may remain on earlier revisions. Native JSON or native-agent edits require restart;
instance apply uses the running native baseline and does not prove the host loaded edited native files.
`/reload-configs` follows the same instance-scoped path. Existing conversations survive. With the current host,
TUI sessions may retain their previous model and variant after apply. Choose the destination/base model through
`/models`, then its configured variant or `Default` through `/variants`.

**Compose → Running configuration inspector** reads the server independently of the saved composition preview.
Use **Refresh** to reread it; invalid saved composition does not prevent native observations.

| Inspector view              | Meaning                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Running workspace defaults  | Current server `model`, `small_model` and `default_agent`; omitted values remain fallback/unset.                  |
| Running agents              | Configured running agent model, variant, `temperature`, `topP` and options.                                       |
| Applied Composer parameters | Validated applied model-bound model/variant and parameter contributions, excluding pending saved edits.           |
| Recorded conversation       | Stored session fallback, latest recorded request and response, and an earlier completed response when applicable. |

Missing, stale or foreign applied metadata makes Composer parameters unavailable; it does not replace them with
saved settings or hide observable native defaults. Running values have no source-file attribution in this view;
use the saved preview for authored provenance. Refresh if configuration changes during inspection.

Current unsent TUI model/variant selections and complete final provider request parameters are unavailable through
the pinned host's public APIs. Configured settings and recorded history do not establish the next request; native
pins, selected variants, capability limits, provider defaults and other plugins can affect dispatch. Values under
credential-like option keys are redacted; provider configuration and conversation bodies are omitted. Inspection does not save,
apply, select models, dispose an instance, send a prompt or change history.

## Migration

Migrate a copy of settings; there is no automatic conversion or legacy compatibility mode.

| Old location                                | Current location                                                    |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `agent.groups` or root `groups`             | `componentGroups`, with explicit members and profile selection.     |
| `agent.modelPresets` or root `modelPresets` | `configurationPresets`, assigned by targeted profile layers.        |
| `agent.prompts.defaults`                    | `defaults.agents.prompt`.                                           |
| `agent.prompts.overrides.<name>`            | `overrides.agents.<name>.prompt`.                                   |
| Agent/command/skill definitions             | `components.agents`, `components.commands`, `components.skills`.    |
| Root `model` / `small_model`                | `defaults.model` / `defaults.small_model`.                          |
| File-path `activeProfiles` / `extends`      | Explicit `imports`, named `profiles`, named selections and parents. |

Old `agent`, `command` and `skill` namespaces are rejected even when empty. Diagnostics identify the key and
suggest its destination. `sourceDirectories` retains its include-alias meaning. Preserve native authored pins
unless you deliberately intend to replace them; compare both selected profiles and fallback behavior after migration.
