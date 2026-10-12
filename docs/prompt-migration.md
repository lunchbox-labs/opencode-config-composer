# Separating prompt composition

Config Composer now handles configuration only. Prompt composition lives in
[@lunchbox-labs/opencode-prompt-composer](https://github.com/lunchbox-labs/opencode-prompt-composer).
This is a source change awaiting release; no package is published by this PR.

Before updating, keep a copy of your configuration and move the following settings out of every shared,
project, local and imported Config Composer document:

- `sourceDirectories` and `components.prompts`.
- Agent `promptRefs` and group `prompts` memberships.
- `configuration.prompt`, `defaults.agents.prompt`, and scoped/profile `overrides.agents.<name>.prompt`,
  including `prepend`, `append`, `inheritDefaults`, and `inheritGroups`.
- Older `promptSources`, `promptDefaults`, `agentPrompts`, and `agent.prompts` settings.

Config Composer rejects removed fields with their source and field location, including empty values.
It does not silently ignore them or rewrite files. Move dynamic includes to Prompt Composer's documented
configuration. Profile-driven prompt changes have been removed: changing a Config Composer profile does
not choose or change prompt contributions, and neither package bridges those selections. Review any prior
profile-dependent guidance before migrating; there is no automatic equivalent conversion.

Ordinary OpenCode `agent.prompt` strings, authored agent Markdown, command templates, and skill bodies stay
with OpenCode. Config Composer's inline/file agent and command definitions remain available for components
that are not already defined in OpenCode. Do not duplicate native components in Composer mappings.

Config Composer leaves `{{include:...}}` markers, escaped markers, and `@alias/path` text unchanged. It no
longer reads include files or transforms native skill results. Install and configure Prompt Composer if
those markers should expand; otherwise replace them with authored text. Removing settings alone does not
expand remaining markers. With both packages installed, Prompt Composer is the sole include expander.
Register Config Composer before Prompt Composer (or another body-transforming plugin). Configuration and
agent availability resolve first; the downstream plugin then processes the resulting bodies. Profiles never
select prompt additions. Config Composer's post-hook checks ignore only agent `prompt` and command `template`
text; every other configuration field and component identity remains checked. Authored native-input validation,
source revisions and stale-write safeguards remain strict, so running a body transformer first can invalidate
the editor's native baseline. Consult the counterpart's installation guidance for its registration details.

The former implementation remains recoverable from Config Composer commit
`d21789c4234dc3f05c1ebf7336cd277f1c0df6c9`; its runtime, editor and include tests are available in Git history.
