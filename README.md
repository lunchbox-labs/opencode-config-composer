# OpenCode Config Composer

Compose OpenCode agents, skills, commands and prompts into reusable workflows. Component groups bundle related
components, configuration presets supply reusable settings, and profiles select a setup for the whole project.
Use `/compose` to inspect, edit, save and apply your setup.

This project is independently maintained and is not affiliated with OpenCode or Anomaly.
The package is **`@lunchbox-labs/opencode-config-composer`**. Supported host: **OpenCode V1 1.18.34**.

## Install

`opencode.jsonc`:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-config-composer@VERSION"] }
```

`tui.jsonc`:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-config-composer@VERSION"] }
```

Composer's editors require the server plugin entry in the shared configuration, including for project workflows.

## Components, groups, presets and profiles

| Concept              | Configuration key      | Purpose                                                                           |
| -------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| Component            | `components`           | An agent, skill, command or prompt.                                               |
| Component group      | `componentGroups`      | A named bundle of related components, optionally with settings for member agents. |
| Configuration preset | `configurationPresets` | Reusable model, variant, parameters or permissions, independent of membership.    |
| Profile              | `profiles`             | Ordered group and preset layers, an optional parent profile, and final overrides. |

Define components under `agents`, `skills`, `commands` and `prompts`. An agent supplies an inline `prompt` or
Markdown `file`; a skill names a native `SKILL.md`; a command supplies a `template` or Markdown `file`; a prompt
supplies inline `text` or a `file`. Each definition uses exactly one of its supported content forms.

Definitions alone do not activate a workflow. Profile layers select a `componentGroup`, or assign a
`configurationPreset` to a `target` of agent names, component group names, or both. Presets configure already
selected agents. Group targets apply settings to member agents, not to skill or command bodies.

Relationships are explicit. A command's `agent` names its target. An agent's `promptRefs` appends named prompt
bodies in order. An agent's `skills` records intended on-demand relationships; it does not load skill bodies
or restrict access. A group's `prompts` list alone does not inject those prompts into every agent.

## Complete review and programming example

See the [example directory and composition notes](docs/examples/review-programming/README.md).

| Group         | Agents                          | Skills                           | Native commands              |
| ------------- | ------------------------------- | -------------------------------- | ---------------------------- |
| `review`      | `code-reviewer`, `test-auditor` | `code-review`, `test-audit`      | `review-code`, `audit-tests` |
| `programming` | `implementer`, `test-writer`    | `implementation`, `test-writing` | `implement`, `write-tests`   |

[config-composer.jsonc](docs/examples/review-programming/config-composer.jsonc) references skills and shared
scope prompts, appends those prompts through group configuration, and defines groups and reusable presets.
[profiles.jsonc](docs/examples/review-programming/profiles.jsonc) is explicitly imported and contains:

- `base-workflow`: selects `review`, then `programming`, and assigns each group's permission preset.
- `claude-coding`: extends `base-workflow`, assigns `claude-code` to all four agents, then allows `git *`
  for `code-reviewer` in its final override.
- `openai-coding`: extends the same parent and assigns `openai-code` to the same agents.

With no additional overrides, native authored model pins or session-selected models, the configured result is:

| Agent           | Claude profile model | OpenAI profile model | `git status`: Claude / OpenAI | `npm test`: both |
| --------------- | -------------------- | -------------------- | ----------------------------- | ---------------- |
| `code-reviewer` | Claude Sonnet 4.5    | GPT-5                | allow / ask                   | deny             |
| `test-auditor`  | Claude Sonnet 4.5    | GPT-5                | ask / ask                     | deny             |
| `implementer`   | Claude Sonnet 4.5    | GPT-5                | allow / allow                 | ask              |
| `test-writer`   | Claude Sonnet 4.5    | GPT-5                | allow / allow                 | ask              |

All four agents receive the 4,096-token output limit. Removing the Claude reviewer's final Git override
restores `ask` while retaining its earlier npm denial. Unmatched requests use native permission fallback.
Native files remain registered when no profile is selected; clearing profiles removes their Composer settings
and scope prompt appends, leaving the authored Markdown bodies and native global defaults.

## Built-in and custom agent membership

Groups can name built-in agents directly. This complete minimal document selects a built-in workflow:

```jsonc
{
  "componentGroups": { "coding": { "agents": ["build", "plan", "explore"] } },
  "profiles": { "coding": { "layers": [{ "componentGroup": "coding" }] } },
  "activeProfiles": ["coding"],
}
```

Ordinary availability controls exclude internal `compaction`, `title` and `summary` agents.

The `groups` frontmatter field adds Composer memberships:

```yaml
---
description: Review the current change
mode: subagent
groups: [review]
---
Review the diff and report actionable findings.
```

JSONC member names keep authored order; frontmatter-only members follow in lexical name order. A name present
through both paths occurs once. Native `options.groups` is supported; direct `groups` takes precedence when
both exist. Selecting the group applies its configuration once per member, in profile layer order.
Unknown or unavailable members produce diagnostics. `/compose` offers membership repair before activation.

The editor treats native project sources as read-only; JSONC memberships remain editable.

## Shared, project and local settings

Composer loads these scopes in order:

| Scope   | File                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------- |
| Shared  | `config-composer.jsonc` in the OpenCode configuration directory, or the selected `configFile`. |
| Project | `.opencode/config-composer.jsonc` under the current project/worktree root.                     |
| Local   | `.opencode/config-composer.local.jsonc` under the same root.                                   |

The shared directory uses `OPENCODE_CONFIG_DIR` when set, otherwise an absolute `XDG_CONFIG_HOME/opencode`,
otherwise `~/.config/opencode`. Relative `OPENCODE_CONFIG_DIR` resolves from the process working directory.
A relative `configFile` resolves from the shared directory. Select a custom file with the server options tuple:

```jsonc
{
  "plugin": [["@lunchbox-labs/opencode-config-composer@VERSION", { "configFile": "settings/custom.jsonc" }]],
}
```

Missing default shared/project/local files are allowed; an explicitly selected `configFile` must exist.

`imports` lists explicit local `.json` or `.jsonc` definition files. Imports, component files and
`sourceDirectories` aliases resolve from their declaring document. Imported definitions do not activate
profiles and cannot contain root `activeProfiles`, `defaults` or `overrides`. Duplicate named definitions,
import cycles and repeated canonical identities are rejected.
Automatic discovery of Composer definition files remains deferred.

`activeProfiles` contains ordered names, not filenames. The highest scope supplying the key replaces the
earlier selection. Omit the key to inherit; `[]` selects none. A local selection can replace the example's
shared or project `claude-coding` selection:

```jsonc
{ "activeProfiles": ["openai-coding"] }
```

Removing that local key restores inheritance. Selecting none leaves independent document defaults and
overrides in effect.

## Precedence, prompts and permissions

Shared, project and local defaults establish the baseline. Active profiles replay left to right; each parent
chain replays before that profile's layers and overrides. A and B extending Base replay Base → A → Base → B.
Shared, project and local document overrides apply last. Ordinary objects merge by field; ordinary arrays
replace inside merged values. Parent and child layer lists replay separately.

Model settings support `model` or `modelRef`, plus `variant` and typed `parameters`. References are
`opencode:model`, `opencode:small_model` and `preset:NAME`. Native references use final effective workspace
defaults. Native authored agent model/variant pins take precedence over defaults and group/preset layers;
explicit per-agent overrides can change pins. Session selections remain native authority. Parameters apply
only to their bound dispatched model. Within one ordered replay, changing the resolved model or authored model reference clears inherited
Composer parameters and variant, even when different references resolve to the same model. Unchanged bindings
and parameter-only layers retain earlier contributions; omitted values fall back to native settings or remain unset. Switching profiles starts a fresh replay and removes previous-profile-only settings even when the
model is unchanged. Model/reference edits clear stale authored variants and parameters in the edited definition and affected dependents,
including inactive profiles. Explicit new values and destination/base defaults remain authoritative. A read-only
affected source blocks the whole save; unrelated settings and reusable definitions are preserved.

Prompt assembly is default prepend, ordered group prepend, agent prepend, authored body, default append,
ordered group append, agent append. `inheritDefaults: false` and `inheritGroups: false` suppress inherited
prompt layers. Built-ins without an authored prompt retain native prompts. `{{include:@shared/path.md}}`
expands a file under a declared `sourceDirectories.shared` alias in agent prompts, fragments, commands or
native skill bodies. A preceding backslash escapes the directive. Includes may nest; unsafe paths, escaping
symlinks, cycles, invalid UTF-8 and oversized content are rejected. Native skill wrappers and resources are retained.

Permission arrays contain ordered rules with `tool`, optional `pattern`, and `action` (`allow`, `ask` or `deny`).
Omitted patterns mean `*`. **Later matching Composer contributions win, even when looser.** A later nonmatch
leaves an earlier match intact. Partial object merges preserve earlier rules for keys the later object does
not replace. Deny Git, then allow every tool/target, then ask for npm: Git is allowed and npm asks. Removing
that broad allow restores Git's denial. There is no implicit deny-wins or specificity priority.

When no Composer rule matches, evaluation uses native globals and defaults; an explicit `ask` is a match.
If a scope's policy cannot be represented faithfully in OpenCode, Composer warns clearly and skips that
scope's Composer permission contributions. An affected agent retains native agent permissions plus the applied
global policy; an affected global scope retains native globals while independent agent scopes may still compile.
**The fallback can be more permissive.** Other configuration continues. Warnings appear in stderr and the native
TUI, identify affected sources, and recur on affected session use. Composer adds no blocking policy or session
permission overlays. See the [configuration reference](docs/composition-schema.md) for exact ordering.

## Save, switch and apply

`/compose` shows the saved composition preview, sources, profiles, memberships, settings, permissions,
prompts and availability. Saved values can differ from running configuration. `/agent-models` and
`/agent-groups` open focused editors; `/reload-configs` opens the same current-instance apply flow.

Choose **Compose → Running configuration inspector** to read current server `model`, `small_model` and
`default_agent` defaults, running agent settings, and separately labeled applied Composer model parameters.
**Refresh** rereads the server. Saved edits awaiting apply remain in **Saved composition preview**;
the running inspector is available even when saved composition is invalid. Missing or stale applied metadata
is labeled unavailable rather than replaced with saved values.

**Recorded conversation** separates stored session fallback, the latest recorded request and response, and an
earlier completed response when applicable. These records do not predict the next request. OpenCode's public APIs
do not expose the current unsent TUI model/variant selection or complete final provider request parameters;
configured parameters are settings, not verified request values. Values under credential-like option keys are redacted.
Inspection sends no model request and does not save, apply, select models or modify conversation history.

The editor preserves comments and unrelated fields, verifies shared filesystem access,
and rejects stale snapshots and symlinked write targets. Imported definitions are
edited in their declaring file only when writable within the configuration directory; outside sources and
aliases are read-only. Remote filesystem editing is unsupported.

Saving and applying are separate. Apply when the current instance is idle, or restart. Apply rechecks reviewed
inputs after checking activity, reboots the current instance and verifies the requested revision before reporting
success. It does not apply to every workspace on the server. Other instances may retain older settings.
Native JSON or native-agent edits require restart; instance apply uses the running native baseline and does not
prove the host loaded edited native files.
If apply fails, saved changes remain available for retry or restart.

Profile switching applies project-wide and rebuilds effective settings from the original native/base configuration
plus the newly selected profiles in their declared order. Contributions from deselected profiles are removed,
restoring base values when present. Reusable definitions, base files and conversation history are preserved.

**Native selection limitation (OpenCode 1.18.34):** Existing conversations can retain the previous TUI model/variant;
clearing profiles can also retain a recorded session model. In the existing TUI conversation, use `/models` to select
the destination model, then `/variants` to select its destination/base variant, or **Default** when none is configured.
Select the inherited base model when clearing profiles.

`agentAvailability` decisions replay with profiles: later explicit true/false decisions win and absence inherits.
Activation must retain a visible enabled primary agent and a valid default. If a session's old agent is unavailable
after apply, continue with an enabled agent; explicit headless requests naming a disabled agent fail before dispatch.

`profileShortcuts` names saved profile selections. Each declared name becomes a palette action and slash
command with that name. These actions use the same preview/save/apply path; they do not execute prompt commands
or make model requests. Collisions are reported; refresh shortcuts in `/compose` after editing definitions.
An empty shortcut selection returns to no active profiles.

## Skills and supported surface

The package includes native `config-composer-create`, `config-composer-explain` and `config-composer-migrate`
guidance skills. Composer registers installed paths and respects colliding native skill names.
Composer's declared component files are read during resolution.

Public exports are the root/server plugin, the TUI plugin and `schema.json`. Internal modules are not supported
imports. Development requires Node 22.18 or newer, npm, and the pinned host types.

For local checks, use `npm ci` and `npm run check`. `npm run test:native` uses the binary selected by
`OPENCODE_BIN` and requires Python 3 and a Unix pseudo-terminal. Scripts verify the exact host baseline.

See the [configuration reference](docs/composition-schema.md) for field constraints and migration.
This project is licensed under MIT. See [LICENSE](LICENSE).

## Integration tests

Run `npm run test:integration` for the installed-package native suite on Linux or Windows x64.
It uses OpenCode 1.18.34 and a deterministic local provider. See the
[integration guide and coverage matrix](docs/integration-tests.md) for setup, assertions,
diagnostics, and remaining feature coverage.
