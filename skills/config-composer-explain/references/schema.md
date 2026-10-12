# Canonical composition reference

Use the installed package's `schema.json` to validate JSONC. Legacy keys are rejected with migration guidance.
OpenCode's native configuration stays in its own files. Composer's default shared source is
`config-composer.jsonc` beside the native global configuration; an explicit plugin `configFile` is supported.

| Key                      | Role                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `components.agents`      | Reusable inline `prompt` or Markdown `file`; optional `skills`, and `configuration`       |
| `components.skills`      | Explicit native `SKILL.md` file definitions                                               |
| `components.commands`    | Native command `file` or inline `template`                                                |
| `componentGroups`        | Any mix of agent/skill/command names plus optional agent configuration                    |
| `configurationPresets`   | Reusable model, variant, parameters, and ordered permission settings                      |
| `profiles`               | Optional named `extends`, ordered `layers`, `agentAvailability`, and explicit `overrides` |
| `defaults` / `overrides` | Scoped model defaults, global permissions, and selected-agent settings                    |
| `selection`              | Configured `defaultProfiles` and `retainOnRestart` policy for project selections          |
| `activeProfiles`         | Legacy profile defaults, used only when no scope supplies `selection.defaultProfiles`     |
| `imports`                | Explicit JSONC paths; no automatic directory scan                                         |

A group layer selects components. A preset layer configures agents already selected by earlier layers or an availability decision;
it must specify `target.agents` and/or `target.componentGroups`. Parent layers replay before child layers.
Active profiles replay in list order. Reusable imported files must contain definitions and imports only:
top-level `selection`, legacy `activeProfiles`, `defaults`, and `overrides` are rejected rather than silently
ignored. Shared, project, and local scope files participate in that order. Later supplied selection fields
replace earlier ones; profile lists are not combined.

A saved project selection overrides configured `selection.defaultProfiles`, including when the saved list is
empty. If no scope supplies `selection.defaultProfiles`, the highest-scope legacy `activeProfiles` list supplies
the defaults. Editing either default list does not replace a saved selection. In `/compose-configs`, save
**Select no profiles** to override the defaults with an empty list, or **Use configured defaults** to remove
the project override. Apply the saved change separately. Selecting no profiles leaves independent document
defaults and overrides in effect.

Selections are stored outside configuration files and retained across server restarts by default. With
`selection.retainOnRestart: false`, a selection lasts for the current server process, including apply/reload;
a new process starts from configured defaults. This temporary selection does not erase a retained choice,
which becomes active again if retention is re-enabled.
Native group frontmatter can add agents to an existing selected group without duplicating native definitions.

```jsonc
{
  "componentGroups": { "reviewers": { "agents": ["plan", "explore"] } },
  "configurationPresets": {
    "review-access": {
      "permissions": [{ "tool": "bash", "pattern": "git *", "action": "ask" }],
    },
  },
  "profiles": {
    "review": {
      "layers": [
        { "componentGroup": "reviewers" },
        {
          "configurationPreset": "review-access",
          "target": { "componentGroups": ["reviewers"] },
        },
      ],
    },
  },
  "selection": { "defaultProfiles": ["review"] },
}
```

Agent settings use `model` OR `modelRef` (`preset:<name>`, `opencode:model`, or `opencode:small_model`).
A reference supplies model-bound settings; a targeted preset layer also contributes its permission rules.
Within one ordered replay, changing the resolved model or authored model binding clears inherited Composer
variant/parameter values, even when a new reference resolves to the same model. An unchanged binding or a
parameter-only layer retains earlier contributions from that replay. New explicit settings apply after the
reset; omitted values fall back to applicable native settings or remain unset. Switching profiles reconstructs from the original
native/base configuration and removes old-profile-only settings, including when the destination resolves to
the same model. Base values remain unless overridden. Native explicit pins remain unless
an explicit component or agent override changes them. Parameters support `temperature`, `topP`, `topK`,
`maxOutputTokens`, and JSON provider `options`; capability validation depends on the selected model.

`defaults.agents` applies to selected agents before profile settings. `overrides.agents.<name>` and profile
agent overrides apply explicitly to selected agents. Global permission rules use `defaults.permissions` and
`overrides.permissions`, with active profile global overrides between scoped defaults and scoped overrides.
Agent rules compile after applied global permissions and native agent permissions. Only a nonmatch falls
back; `ask` is a real match. Repeated ordered rules are retained, including later allows after earlier denies.
Unsupported wildcard ordering or host shapes warn and skip every Composer permission rule in that scope.
An affected agent keeps native permissions plus applied globals; a global failure keeps native globals and
lets independent agents compile. Other settings continue. That fallback may omit intended deny rules.

**Compose configs → Running configuration inspector** reads current server defaults and running agent settings.
**Applied Composer parameters** shows validated applied model-bound contributions, not saved edits awaiting apply.
**Recorded conversation** separately labels stored session fallback, latest recorded request/response, and an earlier
completed response when applicable. Missing, stale or foreign applied metadata is unavailable; observable native
defaults remain usable even when saved composition is invalid. **Refresh** rereads the server.
The current unsent native TUI model/variant selection and complete final provider request parameters are unavailable.
Configured settings and recorded history do not predict the next request. Inspection changes no settings or history
and sends no prompt; values under credential-like option keys are redacted and conversation bodies are omitted.

The `skills` relationship describes intended on-demand use; it does not inject bodies or grant access.

`/compose-configs` can author definitions, memberships, profile selection, parameters, permissions. Save and reload are separate. Invalid active memberships have a repair view; malformed
JSONC, imports, and profile/preset reference errors need correction in the named source first.
Read-only imported sources need an explicit writable destination; no tool should silently rewrite them.

Prompt composition belongs to `@lunchbox-labs/opencode-prompt-composer`. Do not migrate old prompt operations into config profiles; profile-driven prompt changes have been removed. Preserve ordinary OpenCode agent prompt strings and command templates.
