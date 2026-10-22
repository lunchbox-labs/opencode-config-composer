# Config Composer

Share native OpenCode settings through agent-owned groups and one selected profile per worktree. Choose profiles with `/profiles` and inspect loaded definitions and applied values with read-only `/view-configs`. The prompt shows the applied profile; the inspector hides built-in agents until toggled. Tested against OpenCode V1 1.19.x.

Add the package to `plugin` in both `opencode.jsonc` and `tui.jsonc`:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-config-composer"] }
```

Declare membership in an agent's frontmatter:

```yaml
groups: [coding, cautious]
```

Define those groups in `config-composer.jsonc` in OpenCode's configuration directory:

```jsonc
{
  "groups": {
    "coding": { "agent": { "permission": { "edit": "ask" } } },
    "cautious": { "agent": { "permission": { "edit": "deny" } } },
  },
  "profiles": {
    "review": {
      "groups": { "coding": { "agent": { "temperature": 0 } } },
    },
  },
  "defaultProfile": "review",
}
```

Later entries in an agent's `groups` array win overlaps. Each group's selected profile patch applies with that group. Explicit native agent frontmatter always wins, including model pins. Built-in and JSON-defined agents declare the same array at `agent.<name>.groups` in `opencode.jsonc`.

Definitions are shared across projects using this file; profile choices persist separately per worktree. **Shared only** skips profile settings. **Follow configured default** follows `defaultProfile` again. Profile changes have a preview and Apply confirmation.

Restart the OpenCode server process after editing files to update loaded definitions. Applying a profile requires an idle instance and unchanged native configuration files. Existing session model/variant choices remain native.

See the [schema](schema.json) and examples for [provider profiles](docs/examples/provider-profiles/config-composer.jsonc), [shared permissions](docs/examples/role-permissions/config-composer.jsonc), and [worktree selection](docs/examples/project-selection/config-composer.jsonc); each example includes native agent membership in its adjacent `opencode.jsonc`. Native OpenCode retains agent prompts and command templates. For prompt composition, see the independent [Prompt Composer](https://github.com/lunchbox-labs/opencode-prompt-composer).

This package is licensed under MIT ([license](LICENSE)).
