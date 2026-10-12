# Referencing OpenCode components

Reference agents, commands and skills by the names OpenCode already discovers. You do
not need to repeat their definitions or file paths in Composer.

| Component | Name to use                                                                    | When references are checked                                                                    |
| --------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Agents    | The name in OpenCode's agent configuration, including built-in agents          | When configuration loads                                                                       |
| Commands  | The name OpenCode assigns to the configured or Markdown command                | When configuration loads; built-in, MCP and skill-generated commands are checked after startup |
| Skills    | The `name` in `SKILL.md` frontmatter, which can differ from the directory name | After startup                                                                                  |

For example, if OpenCode discovers a skill named `review-code`, this group needs no
`components.skills` mapping:

```jsonc
{
  "componentGroups": { "review": { "agents": ["build"], "skills": ["review-code"], "commands": ["init"] } },
  "profiles": { "review": { "layers": [{ "componentGroup": "review" }] } },
  "activeProfiles": ["review"],
}
```

Composer uses OpenCode's discovered components across shared, project and configured
sources. OpenCode determines which definition wins when names overlap and whether a
source is enabled. Existing explicit Composer definitions remain supported, but a
Composer agent or command definition cannot replace a native component of the same name.

## Skill selection and permissions

Group `skills` and Composer agent `skills` can reference native skill names. These
references record relationships; they do not load skill bodies, grant access or limit
which skills an agent can use. Use OpenCode permissions to control skill access.

Explicit Composer skill mappings still add discovery paths when selected. Name-only
references add no paths. Clearing a profile does not remove native skills or commands.

## Missing or unverified references

Missing or disabled references are skipped while valid composition continues. A
reference stays **pending** when discovery has not finished or cannot be checked.

Open `/compose-configs` → **Reference notices** to see affected names and their source locations.
This entry appears only when references need attention or validation is unavailable.
A warning points to it when needed; ordinary menu reads do not repeat the warning.
Correct the source and reload to refresh the notices.

Without the TUI, validation runs on the first chat or command after startup. A skill
that shares its name with a non-skill command can remain unverified in this mode;
open the TUI to check it against the full skill list. Reading configuration alone does
not trigger headless notices, and offline editors cannot fully verify native discovery.

Malformed configuration, conflicting definitions, model-reference cycles and invalid
selection or primary-agent settings still produce errors. Prompt aliases, prompt
composition and include expansion are handled by the separate prompt plugin.
