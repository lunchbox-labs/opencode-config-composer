# Releasing Config Composer

Merge the desired package version into main, then manually run the publish workflow
from main. There are no version or tag inputs: package.json is the sole version source,
and the workflow derives its `vX.Y.Z` tag automatically. No tag or draft preparation is required.
The workflow fixes the selected main commit, validates package metadata, runs checks,
and verifies that packing the same build twice produces identical bytes.

For a new draft, GitHub's official generated release notes provide its name and body,
using the release tag and pinned commit and honoring the repository's release.yml defaults.
Existing draft titles and bodies are preserved, including concurrent draft creation.

The workflow creates or reuses the exact matching tag and stable draft, publishes the
verified tarball to npm, downloads and verifies the registry's exact tarball, attaches
it, and publishes the draft last. An existing tag is never moved. A mismatched draft,
package, registry version, or existing asset fails without overwriting it. GitHub write
permissions are limited to tag/draft preparation and final attachment/publication;
only npm publication receives the OIDC permission.

Rerun failed jobs, or rerun the workflow for the same commit and version. An existing
npm version is skipped only when its identity, optional gitHead, SHA-512 integrity,
and downloaded bytes agree with the verified build. Already-published releases are
accepted only after verifying their exact existing asset; missing or different assets
cannot be retrofitted onto immutable releases. If an npm version exists but its tag or release is missing, preparation fails without
creating replacement GitHub state; investigate that mismatch manually. Partial failures leave the draft in
place for retry. If main advances, rerun the original workflow run to retain its commit.

The asset for version 0.0.6 is
`lunchbox-labs-opencode-config-composer-0.0.6.tgz`. It contains published plugin files
and metadata, but **does not bundle runtime dependencies** such as ajv, jsonc-parser,
and yaml. Install through npm to resolve dependencies:

```sh
npm install ./lunchbox-labs-opencode-config-composer-0.0.6.tgz
```

This is not a standalone or fully offline installation bundle. Registry propagation
is retried for about two minutes before attachment. Logs identify the lifecycle stage, controlled phase, and HTTP status when available
without exposing credentials or response bodies.

The existing immutable 0.0.5 release cannot receive assets. Use the
[npm package](https://www.npmjs.com/package/@lunchbox-labs/opencode-config-composer/v/0.0.5)
or [published tarball](https://registry.npmjs.org/@lunchbox-labs/opencode-config-composer/-/opencode-config-composer-0.0.5.tgz).

The prepare and final attachment/publication steps use a GitHub App installation token.
Create the repository environment `release` and store `LUNCHBOX_LABS_APP_PRIVATE_KEY`
only as its environment secret. Keep `LUNCHBOX_LABS_APP_CLIENT_ID` as an organization
or environment variable with that same name. Remove broader organization/repository
private-key copies or repository access to those copies so the environment is the
credential access boundary. Both App-token jobs explicitly request `release`; npm
retains its separate `npm` environment. Install the
App on this repository with contents write permission, and authorize its identity
under the existing version-tag creation ruleset. `contents: write` alone does not
bypass rulesets. The workflow never changes protection settings or moves existing tags.

The Actions allowlist must permit `actions/create-github-app-token` (pinned here to
v3.3.0 at `64ab729a6294000f5aa4a4bc0b73d1f32bc45510`). Each release job mints a token
only for this repository immediately before its GitHub API step, with contents write
permission and default revocation when the job ends. Its normal workflow token remains
read-only. App credentials and tokens are not passed to builds, tests, npm, or artifacts;
no token is exported between jobs. npm retains its separate read-only GitHub token and
OIDC trusted publishing configuration. Rejected tag creation reports safe phase/status
diagnostics so the operator can identify policy or installation configuration problems.

Restrict the `release` environment to main and consider required reviewer approval.
An environment is not a per-workflow allowlist: another workflow can request the same
environment. Branch restrictions, environment review, protected workflow changes, and
control of who can run or modify workflows therefore matter. These prerequisites are
operator configuration; this change does not create environments or alter settings.
