# Canonical composition reference

Use the installed package's `schema.json` to validate JSONC. Legacy keys are rejected with migration guidance.
OpenCode's native configuration stays in its own files. Composer's default shared source is
`config-composer.jsonc` beside the native global configuration; an explicit plugin `configFile` is supported.

| Key | Role |
| --- | --- |
| `components.agents` | Reusable inline `prompt` or Markdown `file`; optional `promptRefs`, `skills`, and `configuration` |
| `components.skills` | Explicit native `SKILL.md` file definitions |
| `components.commands` | Native command `file` or inline `template` |
| `components.prompts` | Reusable `text` or `file` fragments |
| `componentGroups` | Any mix of agent/skill/command/prompt names plus optional agent configuration |
| `configurationPresets` | Reusable model, variant, parameters, and ordered permission settings |
| `profiles` | Optional named `extends`, ordered `layers`, and explicit `overrides` |
| `defaults` / `overrides` | Scoped model defaults, global permissions, and selected-agent settings |
| `activeProfiles` | Ordered profile names; absence inherits, `[]` selects none |
| `imports` | Explicit JSONC paths; no automatic directory scan |
| `sourceDirectories` | Explicit named roots for prompt include references |

A group layer selects components. A preset layer configures agents already selected by earlier group layers;
it must specify `target.agents` and/or `target.componentGroups`. Parent layers replay before child layers.
Active profiles replay in list order. Reusable imported files must contain definitions and imports only: top-level `activeProfiles`, `defaults`,
and `overrides` are rejected rather than silently ignored. An `activeProfiles: []` selection does not disable
independent scoped global defaults or overrides. Shared, project, and local scope files participate in that order.
Native group frontmatter can add agents to an existing selected group without duplicating native definitions.

```jsonc
{
  "componentGroups": { "reviewers": { "agents": ["plan", "explore"] } },
  "configurationPresets": {
    "review-access": { "permissions": [{ "tool": "bash", "pattern": "git *", "action": "ask" }] }
  },
  "profiles": {
    "review": {
      "layers": [
        { "componentGroup": "reviewers" },
        { "configurationPreset": "review-access", "target": { "componentGroups": ["reviewers"] } }
      ]
    }
  },
  "activeProfiles": ["review"]
}
```

Agent settings use `model` OR `modelRef` (`preset:<name>`, `opencode:model`, or `opencode:small_model`).
A reference supplies model-bound settings; a targeted preset layer also contributes its permission rules.
A different model clears inherited Composer variant/parameter values. Native explicit pins remain unless
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

Prompt operations support ordered `prepend`/`append` strings and `inheritDefaults`/`inheritGroups` controls.
Use `{{include:@source/path.md}}` or an entire `@source/path.md` fragment with a declared source directory.
Repeated `promptRefs` preserve authored order. Native prompts without an authored body remain native.
The `skills` relationship describes intended on-demand use; it does not inject bodies or grant access.

`/compose` can author definitions, memberships, profile selection, parameters, permissions, prompts and
prompt sources. Save and reload are separate. Invalid active memberships have a repair view; malformed
JSONC, imports, and profile/preset reference errors need correction in the named source first.
Read-only imported sources need an explicit writable destination; no tool should silently rewrite them.
