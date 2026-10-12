# Share permissions by role

Manage permissions for four agents in one [Composer configuration](config-composer.jsonc). The developer and
test writer share a group so a policy change applies to both; the reviewer and orchestrator have separate groups.

The `roles` profile selects all three groups and applies these rules:

| Request              | Developer / test writer | Reviewer          | Orchestrator |
| -------------------- | ----------------------- | ----------------- | ------------ |
| Edit a file          | allow                   | deny              | deny         |
| `git diff --stat`    | allow                   | allow             | ask          |
| `npm test`           | allow                   | deny              | ask          |
| Other Bash commands  | ask                     | ask               | ask          |
| Delegate with `task` | OpenCode fallback       | OpenCode fallback | allow        |

The broad Bash `ask` comes before the specific Git and npm rules, because the last matching rule wins.
These are rules for the listed tools and patterns; requests to other tools use OpenCode's permissions.

To give another developer the same rules, add its agent name to the developers group's `agents` list.
No copy of the permission list is needed.

Choose **Select no profiles** in `/compose`, then save and apply, to remove these permission contributions
while leaving the agents and their instructions available. **Use configured defaults** instead clears the saved
selection override and can reselect the `roles` profile. See the [permission ordering and fallback notes](../../../README.md#permissions) for overrides
and the fallback used when a policy cannot be represented faithfully.
