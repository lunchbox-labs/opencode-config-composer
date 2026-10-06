# Composition document contract

`config-composer.jsonc` uses the exported `schema.json`. JSONC comments and trailing commas are accepted;
duplicate keys, unsafe keys, unknown fields, and legacy shapes are rejected. This contract defines input
validation. The server and TUI do not yet consume these documents; source assembly, reference resolution,
native compilation, and editing integrate separately. There is no canonical-validator legacy mode.

## Definitions and scopes

| Key                    | Meaning                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `components`           | Named `agents`, `skills`, `commands`, and `prompts`. Defining a component does not select it.          |
| `componentGroups`      | Named bundles containing any subset of component kinds and optional `configuration` for member agents. |
| `configurationPresets` | Reusable model/variant/parameter and/or ordered permission settings, independent of membership.        |
| `profiles`             | Named profiles with one optional named `extends` parent, ordered `layers`, and optional `overrides`.   |
| `defaults`             | Runtime `model` and `small_model` defaults, plus an `agents` configuration applied to selected agents. |
| `overrides`            | Runtime `model` and `small_model`, plus `agents` configurations keyed by exact selected agent name.    |
| `activeProfiles`       | An ordered list of profile **names**, not file paths.                                                  |
| `imports`              | Explicit local `.json` or `.jsonc` document paths.                                                     |
| `sourceDirectories`    | Existing source aliases for prompt includes, relative to their declaring document.                     |

An agent supplies exactly one `file` or inline `prompt`; a command supplies exactly one `file` or
inline `template`. Commands may name their `agent` explicitly. A prompt supplies exactly one `file`
or inline `text`; a skill names its native `SKILL.md` with `file`. Agent `promptRefs` appends named
prompt bodies in order. Agent `skills` records intended on-demand relationships: it neither injects
skill bodies nor grants exclusive access. Agent configuration belongs in `configuration`.

Model settings support `model` **or** `modelRef`, an optional `variant`, and typed `parameters`.
References are `opencode:model`, `opencode:small_model`, or `preset:<configuration-preset-name>`.
A model reference selects model-bound settings; a targeted preset layer also contributes permissions.
Partial variant/parameter settings can modify the model resolved at their layer. Model identity changes
reset inherited model-bound settings; catalog/adapter checks and native agent/session authority remain
the runtime resolver's responsibility.

Parameters accept `temperature` (0–2), `topP` (0–1), positive safe integer `topK` and `maxOutputTokens`,
and an `options` object containing JSON values. A preset cannot contain component membership or prompt
operations. Agent `prompt` supports ordered `prepend`/`append` operations and `inheritDefaults` /
`inheritGroups` controls.

## Ordered composition

Each profile layer is exactly one of:

```jsonc
{ "componentGroup": "review" }
{ "configurationPreset": "checks", "target": { "componentGroups": ["review"] } }
{ "configurationPreset": "model", "target": { "agents": ["reviewer"] } }
```

Targets may name both agents and groups. A group target means its resolved agent members at that layer,
never its skills, commands, or prompts. Targets must already be selected; assigning settings does not
select components. Unknown, disabled, or unselected references are errors during source/reference resolution.

Shared, project, then local defaults establish the baseline. Replay active profiles left to right,
replaying each full parent chain, including a shared parent on every occurrence. For each profile,
replay its layers then its overrides. Finally apply shared, project, then local document overrides.
Ordinary objects merge by field and ordinary arrays replace within merged definitions. Parent and child
layer lists replay separately; they are not flattened by generic array merging.

Permission rules are ordered `{ "tool": "bash", "pattern": "git *", "action": "allow" }` objects.
`action` is `allow`, `ask`, or `deny`; an omitted pattern means `*`. Repeated and overlapping rules are
valid. Preserve contribution order and authored rule order: **the latest matching Composer contribution
wins, even if looser**. A later nonmatch leaves an earlier match intact. Only no Composer match falls
back to native globals, then native defaults. An explicit `ask` is a match, not a fallback. Replacing a
permission array in a definition must not discard earlier matching contributions from other layers.
This schema does not compile or evaluate native permissions.

Local `activeProfiles` replaces the shared selection. An absent local key inherits; `[]` selects none.
Selecting none does not disable independent document defaults/overrides. The selection helper returns
a fresh array and never mutates the source. Imported profile definitions do not activate profiles.

## Imports and validation boundary

Import and component file paths resolve from the file that declares them. Load imports explicitly in
authored order; do not scan profile directories. Imported files contribute named definitions. Importing
does not apply another file's activation/default/override scopes; the source loader must reject such
scope fields in imported definition documents. Duplicate imported/inline registry names must be
reported with both source locations, rather than silently overwritten. Use explicit defaults/overrides
for deliberate settings changes. Automatic directory discovery and its directory-over-JSONC precedence
are a later source-loading feature.

The document validator checks shapes before assembly, so references may point to names defined in
another imported document. After assembly, validate names, model references, inheritance cycles,
duplicate identities, and selected targets before any runtime mutation. Per-field diagnostics retain
the source identifier and JSON Pointer. Resource bounds are 1 MiB per document, 32 JSON container levels,
64 imports and active profiles, 256 items per other ordered list, and 1,024 definitions per registry.
The source loader also owns aggregate text, file identity, UTF-8, and parent-chain limits.

The [synthetic definition fixture](../tests/fixtures/composition/config-composer.jsonc) and its
[imported profiles](../tests/fixtures/composition/profiles/workflows.jsonc) demonstrate four agents,
four skills, mixed groups, separate model and permission presets, inheritance, and explicit targets.
They test the contract; they do not establish installed native feature acceptance.

## Migration

No automatic conversion or compatibility mode is provided. Migrate a copy of the settings, leaving
native and personal configuration files under their owner's control.

| Old location                                       | Canonical location                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `agent.groups` or root `groups`                    | `componentGroups`, with explicit member names and profile selection         |
| `agent.modelPresets` or root `modelPresets`        | `configurationPresets`, assigned by targeted profile layers                 |
| `agent.prompts.defaults`                           | `defaults.agents.prompt`                                                    |
| `agent.prompts.overrides.<name>`                   | `overrides.agents.<name>.prompt`                                            |
| Agent/command/skill definitions                    | `components.agents` / `components.commands` / `components.skills`           |
| Root `model` / `small_model`                       | `defaults.model` / `defaults.small_model`                                   |
| File-path `activeProfiles` and file-path `extends` | Explicit `imports`, named `profiles`, and named selection/parent references |

Old `agent`, `command`, and `skill` namespaces are rejected even when empty. Migration errors identify
the offending key and suggest its destination. `sourceDirectories` retains its existing meaning.
