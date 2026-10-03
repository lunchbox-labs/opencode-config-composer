# Composition architecture

This is a proposal for expanded composition, not a description of released capabilities.
The [README](../README.md#composition-concepts) defines components, component groups, configuration presets,
and profiles, with complete workflow examples. Its setup sections document current behavior on OpenCode 1.18.34.
Broader group membership, preset assignment, agent-to-skill relationships, and their schema are not finalized.
Directory discovery and directory-over-inline precedence remain unresolved; discovery would not activate a profile.

## Resolution and ownership

One shared resolver should serve runtime composition and source-aware editing:

| Boundary                 | Responsibility                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Source loader            | Read bounded local source documents with canonical identities, declaring-file paths, fingerprints, and editability.   |
| Resolver                 | Expand ordered profiles, resolve references, merge each field by its contract, and retain diagnostics and provenance. |
| Host adapters            | Validate model parameters and permission representation; apply an idempotent runtime overlay.                         |
| Edit planner and storage | Preview exact destinations and affected consumers, validate snapshots, and preserve unrelated content.                |
| TUI                      | Show effective values, sources, edits, and distinct saved/applied revisions using the shared resolver.                |

These are internal responsibilities, not new public package exports. Provenance should retain the winning source,
layer, reference chain, overwritten contributions, and permission order. Effective native input without a known
source file must not acquire an invented filename. Validate the complete result before mutating runtime state.
Routine overlays do not rewrite native configuration or agent Markdown. Recomposition must start from native
input so removed profiles leave no stale prompts, options, or permissions.

## Profiles and field composition

Activation is project-wide. The proposed order is shared base, expanded active profiles, project overrides,
then local overrides. A local selection replaces the committed selection rather than appending to it;
an absent local selection inherits, while an explicitly empty selection activates no profiles.
Separate worktrees have separate activation; instances sharing one worktree do not automatically reload together.

Profiles may extend one parent. Resolve parents before children and replay each chain in active-list order:
A and B both extending Base produce Base → A → Base → B. Reject duplicate active identities, alias cycles,
missing references, and excessive input. Paths retain their declaring-file origin. Proposed bounds are 32 parent
levels, 64 active profiles, 1 MiB per file, and 8 MiB total configuration text. Exact activation paths and reset
syntax need schema agreement; these concepts do not establish a runnable configuration format.

Later scalars win. Named registries merge by name and by field, so a permission-only change need not remove a
model or prompt. Ordinary arrays replace, preserving their authored order. Prompt operation arrays also replace
at the profile-merge stage, before final prompt assembly. Resolve references against the final named definitions. Removing an override
reveals inheritance; deliberately suppressing an inherited Composer value is a separate operation. Neither
operation silently removes native authored pins. Deleting a referenced definition requires updating its consumers.

Model identity/reference, variant, and model-bound options form a unit. Changing identity clears inherited
variant/options before applying explicit replacements; unchanged identity permits field overrides. Revalidate
dependent choices when a preset changes. Composer main/small model defaults are independent overlays, and
native model references resolve afterward. Explicit agent pins and session-selected models remain visible.
Parameters apply only to their intended dispatched provider/model. Preserve native variant precedence and
unrelated provider configuration; distinguish structural validation, catalog observations, and verified adapter
support. Custom typed JSON options do not imply provider support or justify exposing credentials in previews.

## Permission contract and unresolved native mapping

The **latest matching Composer contribution wins**, even when it is looser. Preserve contribution order across
presets, groups, and overrides, and authored rule order within each contribution. A later nonmatch leaves an
earlier match intact. Neither specificity nor deny has automatic priority. Only when no Composer contribution
matches does evaluation fall back to native global permissions, then native permission defaults. An explicit
`ask` is different from no match. Remembered approvals and other host-generated behavior remain host concerns.

For example, deny `bash` / `git *`, then allow all permissions/targets, then ask for `bash` / `npm *`:
`git status` is allowed and `npm test` asks. Removing the global allow makes Git denied again; unrelated requests
fall back to native globals/defaults. See the [README examples](../README.md#ordered-composition) for profile overrides.

Native permission compilation remains unresolved. A last-match evaluator does not prove that grouped native
configuration can express every interleaving. Map replacement or moving retained blocks can change the result.
The mapping of explicit native per-agent permissions also needs definition. Native dispatch tests must establish
interleaved wildcards, later nonmatches, ask versus no match, fallback, removal, and repeated application before
claiming compatibility. Report unrepresentable cases rather than silently approximating this contract.

## Editing, activation, and continuation

The proposed `/compose` UI should expose supported composition settings and their provenance. Value edits target
project overrides by default, or the winning local override with its destination visible. Editing a shared
definition is an explicit choice with affected consumers shown. Reset/remove and suppression must remain distinct.
Preserve JSONC comments and unrelated keys; reject stale snapshots, changed identities, and symlinked edit targets.
Retain shared-filesystem verification. Multi-file edits need reviewable changes and rollback handling, without
claiming cross-file atomicity. Remote filesystem editing and automatic native-file migration are outside scope.

Saving and applying are separate. Apply is explicit when idle, or changes take effect after restart. Scoped
reload/rebootstrap and applied-revision reporting need native verification; instance disposal alone does not
prove fresh configuration. Other instances can retain older revisions, and activity checking is not an atomic
hot-switch guarantee. The existing `/reload-configs` command retains its documented server-wide scope and safeguards.

Proposed profile shortcuts should use the same activation preview/save/apply path, preserve a route back when
profiles change, and avoid collisions with native/TUI commands. They must not reinterpret prompt commands as
configuration actions or run hidden model requests. Exact registration and continuation UI capabilities need verification.

Proposed agent availability overrides may disable and later re-enable agents while retaining definitions and
memberships. Hidden and disabled remain distinct. Activation must leave a usable visible primary agent and a
valid default; ordinary workflow toggles exclude internal title/summary/compaction agents. Preserve session
history and running work. If a prior agent is unavailable after apply, show an enabled continuation choice;
headless callers must choose an enabled agent explicitly. Do not promise uninterrupted session migration.

## Skills and compatibility boundaries

Prefer namespaced native skills and source-relative references for composition guidance. Packaged resources need
explicit installed-path registration and tarball verification; npm plugin installation alone does not establish
skill discovery. Skill membership neither injects guidance nor establishes exclusive access. Migration guidance
should propose a behavior-preserving diff and retain native pins unless their removal is explicitly requested.
A custom lazy loader remains separate research; loaded text is not guaranteed permanent context after compaction.

Preserve current path containment, UTF-8, include-size/cycle, comment, and stale-write safeguards. Expanded schemas
must reject malformed types, unsafe keys, missing references, and cycles while allowing looser permission overrides.
Resolver and editor checks need installed-package/native-host evidence for dispatch, skill discovery, reload scope,
and continuation behavior. This proposal adds no product implementation, dependency changes, or host-version expansion.
