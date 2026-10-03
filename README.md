# OpenCode Config Composer

This project is independently maintained. It is not built by the OpenCode team and is not affiliated with
OpenCode or Anomaly.

Compose agent prompts, ordered group defaults, reusable model presets, and inline includes in native skill output.
The TUI provides `/agent-models` and `/agent-groups` for reviewing and saving settings.
Use `/reload-configs` to open the same reload flow as **Reload saved settings…** in `/agent-models`.
Choose **Reload now…** and confirm to apply saved settings. Reload affects all workspaces on the server;
wait for agents in every workspace to finish. Existing session model selections remain in effect.
The command retains the menu's running-agent checks, filesystem checks, and success/error feedback.

The npm package name is **`@lunchbox-labs/opencode-config-composer`**.

Supported and tested host: **OpenCode V1 1.18.34**. The `opencode` engine requirement is intentionally exact.
Broaden it only after checking another host version. This package does not implement a V2 port.
Development requires Node 22.18 or newer and npm. Compiled runtime files do not require TypeScript or OpenTUI packages.
Host types and OpenTUI dependencies are development-only; the host supplies the TUI API.

## Composition concepts

The following vocabulary describes the expanded composition design.
The setup and configuration examples later in this README describe current behavior.

| Term                 | Meaning                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Component            | An agent, skill, command, or prompt.                                                                                      |
| Component group      | Related components bundled together with their configuration. Any subset of component types is valid.                     |
| Configuration preset | Reusable settings, such as model options or permissions. It does not require component membership.                        |
| Profile              | A named, project-wide active setup combining ordered component groups and configuration presets, plus optional overrides. |

These are logical roles, not mandatory file boundaries. A model choice is configuration, not a component.
A permissions-only or model-only configuration preset is useful on its own. A component group may contain only
prompts, only skills, or a deliberate mix of agents, skills, commands, and prompts for a workflow.

A group describes what belongs together; a preset supplies reusable settings; a profile chooses the setup to use.
Bundling a skill with an agent does **not** automatically inject that skill into the agent's prompt.
Relationships must be configured explicitly: for example, which command invokes an agent, which guidance is
included in its prompt, and which skills remain available to load when needed.

### Example: two workflows, reusable presets, two profiles

This example describes the intended design end to end. **It is conceptual, not a runnable configuration or
a set of shipped resources.** The names below are example definitions. Exact syntax for component membership,
preset assignment, and agent-to-skill relationships is not finalized.

First, define two component groups:

| Component group | Agents                                                                | Skills                                      | Commands and prompts                                                                                                                         |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `review`        | `code-reviewer` checks the diff; `test-auditor` checks test coverage. | `review-checklist` and `test-verification`. | `review-diff` invokes `code-reviewer`; `review-tests` invokes `test-auditor`. A review-scope prompt defines what each review should report.  |
| `programming`   | `implementer` changes code; `test-writer` adds tests.                 | `coding-conventions` and `test-authoring`.  | `implement-change` invokes `implementer`; `write-tests` invokes `test-writer`. An implementation-scope prompt describes the intended change. |

Make the relationships explicit:

- `code-reviewer` uses the review-scope prompt and can load `review-checklist`.
- `test-auditor` uses the review-scope prompt and can load `test-verification`.
- `implementer` uses the implementation-scope prompt and can load `coding-conventions`.
- `test-writer` uses the implementation-scope prompt and can load `test-authoring`.

“Can load” does not mean automatic loading or exclusive access. These relationships describe intended use,
not a new permission boundary. Each command has one named agent target; membership alone does not create that
target, run a command, or inject either skill into every agent's prompt.

Next, define configuration presets independently of those groups:

| Configuration preset | Intended settings                                                                 | Applied to in this example          |
| -------------------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| `claude-code`        | Claude Sonnet 4.5 model selection; output-token limit 4,096.                      | All four agents.                    |
| `openai-code`        | GPT-5 model selection; output-token limit 4,096.                                  | All four agents.                    |
| `review-checks`      | Ask for `bash` commands matching `git *`; deny `bash` commands matching `npm *`.  | `code-reviewer` and `test-auditor`. |
| `programming-checks` | Allow `bash` commands matching `git *`; ask for `bash` commands matching `npm *`. | `implementer` and `test-writer`.    |

The model names identify intended choices, not a guarantee of provider availability. Select a supported
provider/model ID from the connected catalog. The output-token limit is a proposed request setting; its
serialization and provider validation belong to the expanded parameter design. The permission presets contain
only the rules shown, not a blanket “read-only” or “full access” policy. Other requests use matching contributions
elsewhere or the native fallback. No preset needs fake agents or skills to exist.

Finally, define profiles that reuse these definitions:

| Profile         | Ordered component groups                      | Ordered preset assignments                                                                                                      | Final profile override                                            |
| --------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `claude-coding` | `review`, then `programming`.                 | `claude-code` to all four agents; `review-checks` to the two review agents; `programming-checks` to the two programming agents. | For `code-reviewer` only, allow `bash` commands matching `git *`. |
| `openai-coding` | The same `review`, then `programming` groups. | Replace the model assignment with `openai-code`; keep the same permission assignments.                                          | None.                                                             |

Assume no additional groups, native authored model pins, local overrides, or conflicting contributions.
The expected configured setup is:

| Agent           | Available skill by explicit relationship | `claude-coding` model / output limit | `openai-coding` model / output limit | `git status`: Claude / OpenAI profile | `npm test`: both profiles |
| --------------- | ---------------------------------------- | ------------------------------------ | ------------------------------------ | ------------------------------------- | ------------------------- |
| `code-reviewer` | `review-checklist`                       | Claude Sonnet 4.5 / 4,096            | GPT-5 / 4,096                        | allow / ask                           | deny                      |
| `test-auditor`  | `test-verification`                      | Claude Sonnet 4.5 / 4,096            | GPT-5 / 4,096                        | ask / ask                             | deny                      |
| `implementer`   | `coding-conventions`                     | Claude Sonnet 4.5 / 4,096            | GPT-5 / 4,096                        | allow / allow                         | ask                       |
| `test-writer`   | `test-authoring`                         | Claude Sonnet 4.5 / 4,096            | GPT-5 / 4,096                        | allow / allow                         | ask                       |

For `code-reviewer`, the Claude profile's final `git *` allow overrides the earlier preset's ask.
It does not affect `test-auditor` or either agent's `npm *` rule. Removing that override restores ask.
Switching to `openai-coding` changes the model assignment and removes the Claude profile's override; it does
not duplicate the groups, change command targets, or automatically load skills.

Profile activation is intended to apply project-wide, with a committed selection and an optional higher-priority
local override. For example, a local selection of `openai-coding` supersedes a committed selection of
`claude-coding`; clearing the local selection reveals the committed selection. Switching preserves conversation
history, but does not promise to replace a model already selected in a session or interrupt running work.
Changes require explicit application when idle, or restart. If an agent becomes unavailable, continuation must
make the enabled-agent choice visible rather than silently claim the old workflow still applies.

### Ordered composition

Order is part of the setup. Later applicable settings can override earlier settings, including through profile
overrides. Fields such as prompt fragments retain their own composition rules; this is not a promise that every
array or object merges in the same way.

For the proposed permission system, the **latest matching Composer contribution wins**, even when it is looser.
A later contribution that does not match the request does not erase an earlier match or move an older rule
later in the order. Only when no Composer contribution matches at any level does evaluation fall back to native
global permissions, then native permission defaults. There is no implicit deny-wins or most-specific-rule preference.

For example, apply these contributions in order:

| Order | Contribution                                              |
| ----- | --------------------------------------------------------- |
| 1     | Deny `bash` commands matching `git *`.                    |
| 2     | Allow all permissions and targets with a global wildcard. |
| 3     | Ask for `bash` commands matching `npm *`.                 |

`git status` is allowed: contribution 2 is its latest match. `npm test` asks: contribution 3 matches it.
Contribution 3 does not revive contribution 1 for Git commands. Removing contribution 2 makes `git status`
denied again; a request matching neither remaining contribution uses the native fallback described above.

### What is available now

The current configuration supports ordered settings groups assigned to agents, model/variant presets, prompt composition,
and includes in native skill output. Those groups are a narrower case of component grouping: they do not bundle
skills and commands with agents. The existing `agent.groups`, `agent.modelPresets`, `/agent-groups`, and
`/agent-models` names remain the current configuration and command interfaces.

Mixed component groups, general configuration presets, profiles, and the permission composition described above
are proposed capabilities, not released configuration options. Their schema and faithful mapping to native
permission evaluation still need to be finalized. Directory-based and inline definitions are possible future
representations; neither discovery rules nor directory-over-inline precedence are specified here as supported behavior.
Discovering a definition would not itself activate a profile.

See the [composition architecture](docs/architecture.md)
for the technical design and remaining representation questions.

## Use a local build

```sh
npm ci
npm run build
npm pack
```

Use the tarball filename printed by `npm pack`.
Install it in a separate local directory with `npm install /absolute/path/to/package.tgz`.
Register its **installed package directory** in each configuration file. Replace `/absolute/path/to/installed-package`:

`opencode.jsonc`:

```jsonc
{
  "plugin": ["/absolute/path/to/installed-package"],
}
```

`tui.jsonc`:

```jsonc
{ "plugin": ["/absolute/path/to/installed-package"] }
```

Preserve other plugin entries. Register exactly one Composer server and one Composer TUI entry.
For a registry installation, replace the directory in both files with `@lunchbox-labs/opencode-config-composer@VERSION`.
Replace `VERSION` with the published version. Use the same specifier in both files; OpenCode selects `./server` or `./tui`.
The root export also supplies the server module for direct JavaScript imports.

## Settings and paths

Create `config-composer.jsonc` in the OpenCode configuration directory:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/lunchbox-labs/opencode-config-composer/main/schema.json",
  "sourceDirectories": { "shared": "./prompts" },
  "agent": {
    "modelPresets": { "balanced": { "model": "provider/model-id", "variant": "medium" } },
    "groups": {
      "developers": { "modelRef": "preset:balanced", "prompt": { "append": ["Check your changes."] } },
      "reviewers": { "modelRef": "opencode:model" },
    },
    "prompts": {
      "defaults": { "append": ["{{include:@shared/common.md}}"] },
      "overrides": { "reviewer": { "inheritDefaults": false, "prepend": ["Review carefully."] } },
    },
  },
  "command": {},
  "skill": {},
}
```

Use real provider model IDs and supported variants. The example values are placeholders.
The authoritative [schema](schema.json) is hosted at the raw GitHub URL above, tracking `main`.
For an installed-version schema, use `"$schema": "./node_modules/@lunchbox-labs/opencode-config-composer/schema.json"`
when `node_modules` is beside your settings, or adjust the relative path. A copied schema can use `"$schema": "./schema.json"`.
JavaScript consumers can import the supported `@lunchbox-labs/opencode-config-composer/schema.json` subpath with `{ type: "json" }` import attributes.

The server loads `config-composer.jsonc` by default. To select another file, use a plugin options tuple:

```jsonc
{
  "plugin": [["/absolute/path/to/installed-package", { "configFile": "settings/custom.jsonc" }]],
}
```

- The default filename and a relative `configFile` resolve from `OPENCODE_CONFIG_DIR` when set;
  otherwise from the absolute `XDG_CONFIG_HOME/opencode`,
  or `~/.config/opencode`. A relative `OPENCODE_CONFIG_DIR` resolves from the process working directory.
- Relative `sourceDirectories` paths resolve from the **settings file's directory**, never the package directory.
  Absolute paths and `~/` paths are supported.
- The settings editor operates only on the server's local global/custom configuration directory.
  It requires one `opencode.json` or `opencode.jsonc`. Remote configuration editing is unsupported.
  It verifies shared filesystem access through the server's file API before editing or reloading.
  This check creates a temporary random probe in the configuration directory and removes it afterward.
  If the server cannot read that probe, the editor refuses to change settings.
- Settings use the structured file shape above. Plugin options accept only `configFile` and the editor's
  `reloadToken`. Empty options or only `reloadToken` use the default file.
  A missing or invalid settings file is an error.
- Leave `command` and `skill` empty. Their group settings are reserved; native skill includes use `sourceDirectories`.

## Composition behavior

Assign ordered groups in an agent's Markdown frontmatter or native agent configuration:

```yaml
groups: [developers, reviewers]
```

Later groups override earlier model fields. An explicit agent model remains pinned.
An explicit agent variant can override an inherited variant. Unsupported referenced variants fail at dispatch.
Agent membership uses ordered `groups` arrays.
A group may use a concrete `model`, `preset:NAME`, `opencode:model`, or `opencode:small_model`.
Native references resolve against effective workspace defaults, including project overrides.
Missing presets and unset native references are errors. Presets cannot reference other presets.

Prompt order is: default prepend, ordered group prepend, agent prepend, authored body,
default append, ordered group append, agent append. Agent overrides can disable inherited defaults or groups.
Built-in agents without authored prompts retain their native prompts. Disabled agents are not composed.
Repeated configuration hooks do not accumulate guidance; reload rereads source fragments.

Use `{{include:@shared/path.md}}` in authored agent prompts, composition fragments, or native skill bodies.
Includes can nest. Escape a literal directive with a preceding backslash.
Native skill composition preserves the tool's wrapper, metadata, resources, and base directory.
It does not apply agent prepend/append layers to skills. Truncated skill output is rejected before composition.
Command composition is not implemented.

Includes accept contained `.md` and `.txt` UTF-8 files. Unsafe paths, escaping symlinks, cycles, invalid text,
and excessive depth or size are rejected. Limits are 64 KiB per snippet, 256 KiB per composed prompt,
32 include levels, and 256 include expansions. Settings files have a 1 MiB limit.

## Settings editor

Use `/agent-models` for global defaults, presets, groups, and individual overrides.
Use `/agent-groups` for ordered memberships. Model and variant choices come from the provider API.
Review the proposed scope and retained pins before saving. The editor preserves prompts, comments,
unrelated settings, and permissions. Stale snapshots, concurrent edits, and symlinked settings are rejected.

Reload is explicit. It invalidates configuration in **all workspaces on the server**.
Wait for all agents to finish first; the editor can check activity only in the current workspace.
Saved changes can instead take effect at restart. A current session's selected model may still take precedence.
Nested dialogs retain Back/Escape navigation without reopening after lifecycle or route changes.

## Development and checks

```sh
npm ci
npm run check
OPENCODE_BIN=/absolute/path/to/opencode npm run test:native
```

`check` runs type checking, strict ESLint, formatting, unit/TUI tests, and an isolated tarball installation.
The package check installs production dependencies only and tests server/TUI exports,
path resolution, and rejected internal imports outside the checkout. Unit tests cover package-name recognition,
settings edits, reload tokens, TUI callbacks, and navigation.
The package check also compiles installed declarations and rejected imports with `skipLibCheck: false`.
TypeScript consumers need OpenCode's plugin/SDK and OpenTUI development types, as pinned in this repository.
With TypeScript 6, include `"types": ["node"]` in the consumer's `compilerOptions`.
These types are not runtime dependencies. Normal OpenCode configuration files need no TypeScript imports.
`test:native` requires Python 3 and a Unix pseudo-terminal. It verifies the selected binary's version against
`engines.opencode`, then loads an installed tarball in the native server and TUI.
It checks prompt/group composition, native skill includes, dispatch, live reload, and both rendered Composer menus.
The checks use a synthetic local provider without credentials or paid calls.

`engines.opencode` is the authoritative CLI baseline. CI installs that exact binary through `scripts/opencode.mjs`.
The script checks the independently pinned plugin and SDK libraries against `package-lock.json`.
Library versions describe the development types. Compatibility is verified with the actual CLI and installed package.

TUI navigation helpers are included under `src/tui/`.
The tarball includes compiled modules, declarations, schema, license, TypeScript source, and build configuration.
It excludes tests, CI workflows, maintainer tooling, and credentials.

## Package entrypoints

OpenCode loads the plugin through these entrypoints. Server and TUI imports each expose only their default plugin descriptor:

| Export                                                                                        | Purpose              |
| --------------------------------------------------------------------------------------------- | -------------------- |
| `@lunchbox-labs/opencode-config-composer` or `@lunchbox-labs/opencode-config-composer/server` | Server plugin module |
| `@lunchbox-labs/opencode-config-composer/tui`                                                 | TUI plugin module    |
| `@lunchbox-labs/opencode-config-composer/schema.json`                                         | Settings JSON schema |

The package provides no executable command. `exports` defines the supported import surface.
Settings, configuration, storage, navigation, and package metadata subpaths are not exported.
Published source and runtime files remain inspectable. Export restrictions are an API boundary, not a secrecy control.

## License

This project is licensed under MIT. See [LICENSE](LICENSE).
