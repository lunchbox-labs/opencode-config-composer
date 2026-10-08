# Review and programming example

Copy this directory's contents together into the shared OpenCode configuration directory
(`~/.config/opencode/` by default, or `OPENCODE_CONFIG_DIR`), or into your project's `.opencode/`.
Keep the relative paths. Replace `VERSION` in both plugin lists with your installed Composer release
and use model IDs available through your configured providers. No credentials are included.
If native configuration files already exist, merge the example's settings and plugin entries into them
while retaining your other plugins and preferences.
For project use, retain the shared server and TUI plugin registrations from the
[setup guide](../../../README.md#install): Composer's editors require its server entry in the shared
`opencode.json(c)`, even when the workflow files live in `.opencode/`.

```text
~/.config/opencode/                 # or <project>/.opencode/
├── opencode.jsonc                  # native defaults and Composer server plugin
├── tui.jsonc                       # Composer TUI plugin (/compose)
├── config-composer.jsonc           # groups, prompt appends, presets and active selection
├── profiles.jsonc                  # explicitly imported profile definitions
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

OpenCode natively discovers `agents/*.md` and `commands/*.md`. The filename without `.md` is the
agent or command name. Agent YAML frontmatter supplies `description` and `mode: subagent`; the body
is the base prompt. Command frontmatter supplies `description`, the target `agent`, and `subtask: true`;
the body is the template. `/implement` and `/write-tests` retain native `$ARGUMENTS` substitution.
OpenCode 1.18.34 supports these plural directories and the compatible singular `agent/` and `command/`
forms. Use one declaration per name; see the native [agent](https://opencode.ai/docs/agents/#markdown)
and [command](https://opencode.ai/docs/commands/#markdown) documentation.

[opencode.jsonc](opencode.jsonc) sets global `model`, `small_model` and `default_agent` defaults and
loads Composer's server entrypoint. [tui.jsonc](tui.jsonc) loads its TUI entrypoint. Composer reads
[config-composer.jsonc](config-composer.jsonc) through its normal shared/project scope discovery;
OpenCode does not interpret that document as native configuration.

Composer selects the native agent names in the `review` and `programming` groups. They are deliberately
absent from `components.agents`: defining them again there would conflict with native discovery.
Commands are also entirely native, with no duplicate `components.commands` declarations. Their frontmatter
targets the agent names selected by the groups, so `/review-code` and `/audit-tests` use the review agents,
while `/implement` and `/write-tests` use the programming agents. The groups list the intended skills,
which remain native on-demand resources rather than text preloaded into agent prompts.

The two reusable prompt files are declared as prompt components and exposed through the `prompts`
source-directory alias. Each group's explicit `configuration.prompt.append` adds its scope guidance
after the native agent body, preserving the original composed prompts. A group's `prompts` list alone
does not inject text, and native agent frontmatter does not implement Composer's `promptRefs`.

[profiles.jsonc](profiles.jsonc) defines `base-workflow`, then the `claude-coding` and `openai-coding`
children. The active Claude profile gives all four subagents Claude Sonnet 4.5 with a 4,096-token output
limit; the OpenAI profile instead gives them GPT-5 with the same limit. Reviewers ask for Git and deny
npm, except for the Claude code reviewer's final Git allow. Programming agents allow Git and ask for
npm. Native global settings remain the fallback outside those rules; `build` remains the primary default.

Switching between these profiles keeps the same prompts, command targets and skills. Native files are
registered independently of Composer activation: `activeProfiles: []` removes the profile's model,
permission and prompt layers while leaving the native agents, commands and skills available.

See the repository [setup guide](../../../README.md#install) for installing Composer and the
[complete example walkthrough](../../../README.md#complete-review-and-programming-example) for the
profile result table and shared/project/local precedence.
