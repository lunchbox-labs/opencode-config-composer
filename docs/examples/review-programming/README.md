# Review and programming example

This example coordinates two reviewers and two programming agents. Composer profiles apply permissions and
model settings to them. Switching between `claude-coding` and `openai-coding` changes models and permissions
while keeping the same agents, instructions and commands.

## Compose configuration

[config-composer.jsonc](config-composer.jsonc) defines two agent groups and imports
[profiles.jsonc](profiles.jsonc). The groups refer to the existing agents by name.

| Group         | Agents                          |
| ------------- | ------------------------------- |
| `review`      | `code-reviewer`, `test-auditor` |
| `programming` | `implementer`, `test-writer`    |

In `profiles.jsonc`, `base-workflow` selects the review and programming groups, then assigns their permission
presets. Both child profiles extend that setup: `claude-coding` applies `claude-code` to all four agents, while
`openai-coding` applies `openai-code`. The Claude profile also adds a final Git allow for `code-reviewer`.
The root file's `activeProfiles` selects `claude-coding`; the import itself does not activate a profile.

## Result and profile switching

With the supplied files and no additional overrides or conversation model selections, the configured result is:

| Agent           | Claude profile model | OpenAI profile model | `git status`: Claude / OpenAI | `npm test`: both |
| --------------- | -------------------- | -------------------- | ----------------------------- | ---------------- |
| `code-reviewer` | Claude Sonnet 4.5    | GPT-5                | allow / ask                   | deny             |
| `test-auditor`  | Claude Sonnet 4.5    | GPT-5                | ask / ask                     | deny             |
| `implementer`   | Claude Sonnet 4.5    | GPT-5                | allow / allow                 | ask              |
| `test-writer`   | Claude Sonnet 4.5    | GPT-5                | allow / allow                 | ask              |

Both model presets set `maxOutputTokens` to 4,096. The Claude reviewer's final Git rule replaces the earlier
`ask` for Git without affecting the npm denial. Removing that override restores `ask`. Other requests fall
back to OpenCode's permissions.

Select `openai-coding` through `/compose`, or set `"activeProfiles": ["openai-coding"]` and apply or restart.
The command targets and agent instructions stay the same. Existing conversations can retain their previous model and
variant; use `/models`, then `/variants`, to select the destination model and its variant or **Default**.

Setting `"activeProfiles": []` removes these profiles' model settings and permissions. The
agents, commands and skills remain available, with their original instructions and the OpenCode defaults
from `opencode.jsonc`. Any independently configured Composer document defaults or overrides
still apply.

See [scope precedence](../../../README.md#shared-project-and-local-settings) for local profile selections and
[editing and applying](../../../README.md#edit-apply-and-inspect) for the save/apply flow and its limits.
