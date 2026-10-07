# Composition document contract

`config-composer.jsonc` uses the exported `schema.json`. JSONC comments and trailing commas are accepted;
duplicate keys, unsafe keys, unknown fields, and legacy shapes are rejected. This contract defines input
validation. The explicit source loader assembles definitions and ordered profile chains; the server
composes selected native/custom agents, commands, skills, model settings, and authored prompts.
Canonical TUI editing and permission compilation remain integration prerequisites. There is no legacy
mode in canonical server loading. This draft runtime is not release-ready: OpenCode can catch a plugin
config-hook error and continue with native settings, so a rejected permission contribution is **not**
a fail-closed policy boundary.

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

`componentGroups.<name>.agents` resolves against the complete available native/custom agent registry,
not just `components.agents`. For example, `{ "componentGroups": { "coding": { "agents": ["build", "plan", "explore"] } } }`
needs no shadow agent files or custom declarations. The [pinned OpenCode 1.18.34 agent implementation](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/agent/agent.ts)
also defines `general`, `compaction`, `title`, and `summary`, including hidden agents. This observed list
is checked against the live native registry by the installed-host test. The host initializes its agent
registry after plugin config hooks, so the server uses the complete pinned identity catalog together
with host-supplied custom agents and disabled status during that hook. Only identities are catalogued;
OpenCode still creates every built-in prompt, mode, permission, and default. Missing/disabled explicit
members fail rather than creating agents.

Custom-agent frontmatter `groups` remains a second membership source (including the native
`options.groups` representation). The membership helper forms a union: JSONC member names retain their
authored order, then frontmatter-only member names follow in lexical order, independent of host registry
enumeration. A name present through both paths occurs once. Existing direct `groups` takes precedence
over `options.groups` if both exist. Selecting a group applies its configuration once to each member;
profile layer order determines settings precedence, not the membership source. Membership alone does
not activate a profile or change built-in prompts, modes, permissions, or pinned models. The helper
does not mutate agent data; runtime integration must preserve these fields unless explicitly overridden.

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
never its skills, commands, or prompts. Target agents must already be selected; assigning settings does not select components.
A target group is a selector for its resolved agent members and need not have selected those agents
itself. Unknown, disabled, or unselected references are errors during source/reference resolution.

Shared, project, then local defaults establish the baseline. Replay active profiles left to right,
replaying each full parent chain, including a shared parent on every occurrence. For each profile,
replay its layers then its overrides. Finally apply shared, project, then local document overrides.
Model references to native slots use the final effective `model` and `small_model` after these global
contributions. Native agent model and variant pins take precedence over defaults and group/preset
layers; explicit per-agent overrides can change them. A component configuration pins a model only
when it authors `model` or `modelRef`. Partial parameters bind to the effective model and dispatch only
for that model; session selections of another model retain native settings. Changing the resolved model
clears inherited Composer variant/parameter values. Ordinary objects merge by field and ordinary arrays
replace within merged definitions. Parent and child
layer lists replay separately; they are not flattened by generic array merging.

Permission rules are ordered `{ "tool": "bash", "pattern": "git *", "action": "allow" }` objects.
`action` is `allow`, `ask`, or `deny`; an omitted pattern means `*`. Repeated and overlapping rules are
valid. Preserve contribution order and authored rule order: **the latest matching Composer contribution
wins, even if looser**. A later nonmatch leaves an earlier match intact. Only no Composer match falls
back to native globals, then native defaults. An explicit `ask` is a match, not a fallback. Replacing a
permission array in a definition must not discard earlier matching contributions from other layers.
Global `defaults.permissions` replay in shared/project/local scope order, then active profile
`overrides.permissions` in profile order, then scoped `overrides.permissions`. These global rules apply
without selecting an agent. `defaults.agents.permissions` remains selected-agent-only. Agent rules compile
after applied global rules and native agent permissions. The resolver retains ordered `{agent, rule, origin}`
contributions and global `{rule, origin}` contributions alongside the compiled policies.

Unsupported compilation skips every Composer permission contribution for the affected scope with a warning.
An affected agent keeps native agent permissions plus the applied global policy. An affected global scope
keeps native globals and permits independent agents to compile. Other configuration continues. This fallback
may be more permissive; it does not modify session approvals or add a blocking policy. Stderr and native TUI
events identify skipped sources, replay on affected session use, and report changed/resolved warnings.

A configured permission preview returns a matched `action` or `{ "fallback": "native" }`; a nonmatch
does not invent `ask` or claim a Composer source. Canonical origins address authored rule-array fields,
for example `/configurationPresets/checks/permissions/0/action`,
`/componentGroups/review/configuration/permissions/0/action`, `/defaults/agents/permissions/0/action`,
or `/profiles/review/overrides/agents/build/permissions/0/action`. Document overrides use
`/overrides/agents/<escaped-name>/permissions/<index>/action`. Preserve JSON Pointer escaping,
the declaring source, prior matching candidates, and the distinction from native resolved paths.

Local `activeProfiles` replaces the shared selection. An absent local key inherits; `[]` selects none.
Selecting none does not disable independent document defaults/overrides. The selection helper returns
a fresh array and never mutates the source. Imported profile definitions do not activate profiles.

## Imports and validation boundary

The source loader reads the shared configured file, project `.opencode/config-composer.jsonc`, and local
`.opencode/config-composer.local.jsonc`, in that order. Missing optional scope files are allowed; malformed,
unreadable, or explicitly requested missing files fail. A scope discovered at the same canonical identity
as another scope contributes once. Canonical identity also detects import aliases, cycles, and repeated
imports; imported aliases are read-only. Snapshots retain the original text, fingerprint, and frozen value.

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
They test the full contract. The native runtime scenario separately checks built-in identity coverage,
profile activation/deselection, imported agent frontmatter, commands, and native skill discovery.
Authored prompt bodies support includes and composition; built-ins without a configured prompt retain
their native prompt. Selecting native skill paths also retains OpenCode's own directory-access rules.

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
