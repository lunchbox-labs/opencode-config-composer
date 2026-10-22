# Configuration contract

Root: `$schema`, `defaultProfile`, `model`, `small_model`, `groups`, `agent`, `command`, `profiles`.

Groups: ordered `{ name, description?, members: { agent?: string[], command?: string[] }, agent?, command? }`. At least one nonempty member array. Membership-only groups are valid. Profiles: a map of `{ description?, model?, small_model?, groups?: [{ name, agent?, command? }], agent?, command? }`. All references and targets are exact names and validated even in inactive profiles.

Agent patch: `model`, `variant`, `temperature`, `top_p`, `options`, `mode`, `permission`. Command patch: `agent`, `model`, `subtask`. No null unset operations in the document. Persisted null selection means None; missing selection follows `defaultProfile`.

Precedence: root groups → supplied native fields → root named patches → profile groups → profile named patches → actual authored agent frontmatter. Synthetic empty native maps do not block defaults. Authored options/permission are whole-field pins; empty values are explicit. Later Markdown sources replace each authored whole field. Composer permission objects replace and reorder touched exact tool blocks; scalar actions replace the policy. Native bodies are never edited.

Authored frontmatter is final even over a conflicting later native JSON value. Effective shows the raw authored source and the blocked Composer candidate. Same-batch duplicate native identities and unsupported frontmatter engines or metadata stop composition with a source diagnostic. Correct the native input, restart OpenCode, and review again; normalized host defaults cannot substitute for exact authored authority.

One source defaults to the configuration directory's `config-composer.jsonc`; optional `configFile` is absolute or relative to that directory. Missing implicit source is empty. No source stacking. The UI offers Profile, Groups, and Effective through `/compose-configs`. Profile and Groups edit concrete JSONC settings through preview and one Apply confirmation; Effective shows read-only field details and explicit shared/profile destinations for named exceptions. Native files remain read-only. Member toggles stay staged until review. Inherit removes a setting; variant Default writes an empty string. Busy or failed application remains saved, not applied. Native metadata and JSON changes require restart before applying.
