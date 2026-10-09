# Review and programming example

```text
review-programming/
├── opencode.jsonc
├── tui.jsonc
├── config-composer.jsonc
├── profiles.jsonc
├── agents/
│   ├── code-reviewer.md
│   ├── test-auditor.md
│   ├── implementer.md
│   └── test-writer.md
├── commands/
│   ├── review-code.md
│   ├── audit-tests.md
│   ├── implement.md
│   └── write-tests.md
├── prompts/
│   ├── review-scope.md
│   └── programming-scope.md
└── skills/
    ├── code-review/SKILL.md
    ├── test-audit/SKILL.md
    ├── implementation/SKILL.md
    └── test-writing/SKILL.md
```

[config-composer.jsonc](config-composer.jsonc) explicitly imports [profiles.jsonc](profiles.jsonc).
`base-workflow` selects `review`, then `programming`, and assigns each group's permission preset.
The child profiles apply model presets; `claude-coding` adds a final Git allow for `code-reviewer`.

Groups select existing agents by name. Duplicate identities in `components.agents` or `components.commands`
conflict with native declarations.

The two reusable prompt files are declared as prompt components and exposed through the `prompts`
source-directory alias. Each group's explicit `configuration.prompt.append` adds its scope guidance
after the agent body. A group's `prompts` list alone does not inject text.

`activeProfiles: []` removes the profile's model, permission and prompt layers while leaving the
native agents, commands and skills available.

Composer's editors require the server plugin entry in the shared configuration, including for project workflows.

See the [profile result table](../../../README.md#complete-review-and-programming-example) and
[scope precedence](../../../README.md#shared-project-and-local-settings).
