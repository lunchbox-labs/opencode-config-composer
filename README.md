# OpenCode Config Composer

Compose OpenCode configuration with reusable groups, presets and profiles to switch models and permissions
across your agents. Manage selections, edit settings and inspect the result through `/compose-configs`.

Package: **`@lunchbox-labs/opencode-config-composer`** · Supported host: **OpenCode V1 1.19.0**.
Independently maintained; not affiliated with OpenCode or Anomaly.

## Add Composer

Add the package to `plugin` in both `opencode.jsonc` and `tui.jsonc`:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-config-composer@VERSION"] }
```

The editors need the server plugin registered in the shared `opencode.jsonc`, even when the Composer
configuration lives in a project.

Register Config Composer before any plugin that transforms agent prompt or command template bodies.
This lets it resolve configuration and agent availability before the other plugin processes the resulting
bodies. Downstream body changes preserve Config Composer’s editor baseline; running a transformer first
can make that baseline differ from the authored native inputs.

## Examples

- [Switch providers](docs/examples/provider-profiles/README.md): keep model profiles for rotating provider subscriptions.
- [Share permissions by role](docs/examples/role-permissions/README.md): maintain developer, reviewer and orchestrator policies in one place.
- [Review and programming](docs/examples/review-programming/README.md): combine model profiles and role-specific permissions in a complete configuration.

## Compose configuration

Keep agent, command and skill definitions in their OpenCode files, then use Composer to choose which agents
share settings and when those settings apply. For example, a coding group can keep the same members while
provider profiles assign it different model presets. A reviewer group can share permissions across several agents.

Define membership under `componentGroups`. A group's `agents` list uses existing agent names, including built-ins
such as `build` and `plan`; custom agents can also join through `groups` in their Markdown frontmatter. Its optional
`configuration` applies to member agents when the group is selected. Groups can also reference OpenCode commands
and skills by name without repeating their definitions; group configuration affects only agents.

Put reusable model, variant, parameter and permission settings in `configurationPresets`. A preset has no members
of its own. It can supply either a `model` or a `modelRef`, never both. Use `opencode:model` or
`opencode:small_model` to follow the effective workspace default, or `preset:NAME` to reuse another preset's model
settings. That model reference does not bring along the referenced preset's permissions.

For example, these two sections define a group and a preset without selecting either:

```jsonc
"componentGroups": {
  "coding": { "agents": ["build", "plan"] }
},
"configurationPresets": {
  "workspace-model": { "modelRef": "opencode:model" }
}
```

A profile brings membership and settings together through an ordered `layers` list. Each layer takes one of two forms:

- `componentGroup` names a group to select and applies its configuration to its member agents.
- `configurationPreset` names a preset to apply, with a required `target` identifying the agents to receive it.

Inside a profile, these layers select `coding` before applying `workspace-model` to its agents:

```jsonc
"layers": [
  { "componentGroup": "coding" },
  {
    "configurationPreset": "workspace-model",
    "target": { "componentGroups": ["coding"] }
  }
]
```

Within `target`, use `agents` for a nonempty list of agent names, `componentGroups` for a nonempty list of group
names, or both. Agent names resolve against available built-in and custom agents; group names resolve against
`componentGroups` and expand to their agent members. Both lists together form one set of targets. These are
configuration names, not file paths. To address selected agents directly instead, the preset layer can use
`"target": { "agents": ["build", "plan"] }`.

A preset target must already be selected when that layer runs, usually by a preceding group layer. Targeting a
group does not select it, enable its agents, load its commands or skills, or apply its own configuration. The target group
need not have been selected as long as its available agent members have been. Missing or disabled component
references are skipped with notices while valid configuration continues. References that cannot yet be verified
remain pending; inspect them in **Compose configs → Reference notices**. Unknown profile, group or preset names still
produce errors, as does targeting an available agent that has not been selected. This is why the provider
example selects the coding group before assigning its model preset. See the [component reference guide](docs/native-component-discovery.md)
for discovery timing, skill-access behavior and headless validation limits.

Choose an ordered profile selection in `/compose-configs`; several profiles run from left to right. Configure the
initial selection with `selection.defaultProfiles`. A profile can name
one parent with `extends` to reuse its layers and overrides before adding its own. `profileShortcuts` gives a saved profile
selection a named action in the UI. For profiles that also control which agents are enabled, `agentAvailability`
maps agent names to booleans: `true` selects and enables an agent before that profile's layers, while `false`
disables it without discarding its definition. Selection for composition and availability in OpenCode are separate;
selecting a group does not itself enable a disabled agent.

With a `coding` profile already defined, a child can reuse it and add a targeted preset layer:

```jsonc
"profiles": {
  "workspace-coding": {
    "extends": "coding",
    "layers": [
      { "configurationPreset": "workspace-model", "target": { "componentGroups": ["coding"] } }
    ]
  }
},
"selection": { "defaultProfiles": ["workspace-coding"] }
```

## Shared, project and local settings

Composer reads these files in order:

| Scope   | File                                                                                          |
| ------- | --------------------------------------------------------------------------------------------- |
| Shared  | `config-composer.jsonc` in the OpenCode configuration directory, or the selected `configFile` |
| Project | `.opencode/config-composer.jsonc` under the current project/worktree root                     |
| Local   | `.opencode/config-composer.local.jsonc` under the same root                                   |

Use explicit `imports` to split definitions across local JSON or JSONC files. Imports can contribute groups,
presets, profiles and other named definitions, but cannot supply `selection`, legacy `activeProfiles`, document `defaults` or document
`overrides`. Relative paths resolve from the declaring document, including paths in imported definitions.
Importing a profile does not activate it. Duplicate definition names, import cycles and repeated imports of the
same file are rejected; definitions do not replace one another just because they appear in a later scope.

Configured profile defaults come from `selection.defaultProfiles`. Later scopes replace earlier supplied fields;
profile lists are not combined. Legacy `activeProfiles` supplies defaults only when no scope sets
`selection.defaultProfiles`. To configure an empty default selection:

```jsonc
"selection": { "defaultProfiles": [] }
```

A selection saved through `/compose-configs` or a profile shortcut overrides these defaults for the current project.
It is stored outside configuration files, so changing a default list—including setting it to `[]`—does not
replace a saved choice. Save **Select no profiles** to override the defaults with an empty selection. Save
**Use configured defaults** to remove the override and follow the configured list again. Apply the saved change
when the instance is idle.

Saved selections survive server restarts by default. With `selection.retainOnRestart: false`, a choice lasts
for that server process, including apply/reload, and a new process starts from configured defaults. This does
not erase an earlier retained choice; turning retention back on restores it. Selections are independent across
projects, while sessions in the same project share the applied configuration.

Selecting no profiles removes profile contributions; document defaults and overrides still apply. See
[files, imports and activation](docs/composition-schema.md#files-imports-and-activation) for the full rules and
the [project selection example](docs/examples/project-selection/README.md) for retained and temporary choices.

## How settings combine

Composer starts from OpenCode's configuration and applies document defaults in shared, project, then local order.
`defaults.model` and `defaults.small_model` set workspace defaults; `defaults.agents` supplies settings for agents
selected for composition. Leaving a field out preserves the applicable earlier or OpenCode value.

The active profiles run next, from left to right. For each profile, its full parent chain runs first, followed by
its own layers in order and then its per-agent overrides. A shared parent runs each time: if A and B both extend
Base, selecting A then B runs Base → A → Base → B. Shared, project and local document overrides apply last.
Use `overrides.agents` to address individual selected agents; an override does not select its target.

Later contributions replace earlier values for the same field. Objects merge by field, while arrays replace
inside merged values. Profile layers are separate ordered contributions, so a child's layers run after its
parent's rather than replacing the parent's list. Permission rules follow the matching order described below.

An explicit model or variant in an agent's OpenCode definition takes precedence over Composer defaults and
group/preset settings. A per-agent override can replace that pin. Within a composition, changing a model or its
authored model reference clears inherited Composer variant and parameter settings; parameter-only layers retain
other settings for the same binding. Omitted values then fall back to OpenCode settings or remain unset.

Switching profiles rebuilds the result from the original base configuration. It removes settings supplied only
by the previous selection, even when the destination resolves to the same model. Clearing profiles does the same
rebuild without profile contributions; it does not clear document defaults or overrides. Conversation model
selections are separate from this configuration, as described below. See
[profiles and model settings](docs/composition-schema.md#profiles-and-model-settings) for model references and
parameter behavior in detail.

### Permissions

Permission rules name a `tool`, an optional `pattern` and an `action` of `allow`, `ask` or `deny`. Put global
rules in `defaults.permissions` or `overrides.permissions`, and agent rules in the corresponding agent settings,
groups or presets. Agent contributions follow global contributions.

The last matching Composer permission rule wins, even if it is less restrictive; a more specific pattern or a
`deny` does not automatically take priority. A later rule that does not match leaves the earlier match intact.
Unmatched requests fall back to OpenCode's permissions. If OpenCode cannot represent a scope's policy, Composer warns and skips that scope's
permission contributions; the fallback can be more permissive. See [permission ordering and fallback](docs/composition-schema.md#permission-ordering-and-fallback).

## Edit, apply and inspect

Open `/compose-configs` to inspect sources, edit settings or select profiles. `/agent-models` and `/agent-groups` open
focused editors. Save changes, then apply when the current instance is idle, or restart. Applying affects only
that instance; changes to OpenCode configuration or agent files require a restart. Editing requires shared
filesystem access, and some sources are read-only.

Profile switches preserve conversation history. OpenCode can retain a conversation's previous model
and variant, including after clearing profiles. Use `/models`, then `/variants`, to select the destination or
inherited base settings.

**Compose configs → Last editor error** keeps the latest editor failure available after its toast closes.
Inspection preserves drafts and never retries or saves. Details are bounded and redact credential assignments;
only one error is kept in memory, cleared when the project, connection or instance changes or the plugin stops.

**Compose configs → Running configuration inspector** shows running settings separately from the saved preview.
Recorded conversation values do not reveal the next request or the current unsent TUI model selection.
The [configuration reference](docs/composition-schema.md#files-imports-and-activation) covers editing, applying
and inspection in detail.

For dynamically composing agent prompts, see the standalone [Prompt Composer](https://github.com/lunchbox-labs/opencode-prompt-composer) package.

## Reference and development

See the [configuration reference](docs/composition-schema.md) and [schema.json](schema.json) for field constraints.
Composer includes `config-composer-create` and `config-composer-explain` guidance skills.

Development requires Node 22.18 or newer and npm. Run `npm ci` and `npm run check` for typechecking, lint,
formatting, unit tests and the installed-package test. `npm run test:native` uses `OPENCODE_BIN`, Python 3 and
a Unix pseudo-terminal to test against the version pinned in `package.json`. See the [integration guide](docs/integration-tests.md)
for the Linux/Windows integration suite and coverage.

This project is licensed under MIT. See [LICENSE](LICENSE).
