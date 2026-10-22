# Config Composer

Share native OpenCode settings across existing agents and commands with groups and one selected profile per worktree. Choose profiles with `/profiles` and inspect loaded definitions and applied values with read-only `/view-configs`. Tested against OpenCode V1 1.19.x.

Add the package to `plugin` in both `opencode.jsonc` and `tui.jsonc`:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-config-composer"] }
```

Create `config-composer.jsonc` in OpenCode's configuration directory:

```jsonc
{
  "groups": [
    {
      "name": "coding",
      "members": { "agent": ["build", "plan"] },
      "agent": { "permission": { "edit": "ask" } }
    }
  ],
  "profiles": {
    "review": {
      "groups": [{ "name": "coding", "agent": { "permission": { "edit": "deny" } } }]
    }
  },
  "defaultProfile": "review"
}
```

Groups always apply; a profile adds settings using the same membership. **Shared only** retains the shared groups and named settings. Explicit native agent frontmatter always wins over Composer settings, including model pins.

Definitions are shared across projects using this file; profile choices persist per worktree. **Follow configured default** follows `defaultProfile` again. Profile changes have a preview and Apply confirmation. Edit definitions in the file.

Restart the OpenCode server process to update loaded definitions after editing files. Applying a profile requires an idle instance and unchanged native configuration files. Existing session model/variant choices remain native.

See the [schema](schema.json) and examples for [provider profiles](docs/examples/provider-profiles/config-composer.jsonc), [shared permissions](docs/examples/role-permissions/config-composer.jsonc), and [worktree selection](docs/examples/project-selection/config-composer.jsonc). Native OpenCode retains agent prompts and command templates. For prompt composition, see the independent [Prompt Composer](https://github.com/lunchbox-labs/opencode-prompt-composer).

This package is licensed under MIT ([license](LICENSE)).
