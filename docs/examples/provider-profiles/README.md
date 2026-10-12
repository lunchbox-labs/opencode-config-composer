# Switch providers with a profile

If you rotate provider subscriptions, keep a profile for each provider instead of editing every agent's model.
This [configuration](config-composer.jsonc) switches the existing `build`, `plan` and `explore` agents together:

| Profile     | Model                         |
| ----------- | ----------------------------- |
| `anthropic` | `anthropic/claude-sonnet-4-5` |
| `openai`    | `openai/gpt-5`                |

Select `anthropic` or `openai` in `/compose`, then save and apply. Both profiles extend `coding`, which selects
the same three agents before the model preset is applied. Prompts, permissions and agent definitions stay the same.

You can also put `"activeProfiles": ["openai"]` in `.opencode/config-composer.local.jsonc` to choose a provider
for that checkout. This replaces the earlier selection; remove the local key to inherit it again.

An explicit model pin in an agent's OpenCode definition takes precedence over these group presets. Existing
conversations can also retain their previous model and variant after a switch; use `/models`, then `/variants`,
to select the destination model and its variant or **Default**. Clearing profiles restores the underlying settings.

See [how settings combine](../../../README.md#how-settings-combine) for precedence.
