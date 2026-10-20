# Releasing Config Composer

Merge the desired package version into main, then manually run the publish workflow
from main with its stable `vX.Y.Z` version. No tag or draft preparation is required.
The workflow fixes the selected main commit, validates package metadata, runs checks,
and verifies that packing the same build twice produces identical bytes.

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
cannot be retrofitted onto immutable releases. Partial failures leave the draft in
place for retry. If main advances, rerun the original workflow run to retain its commit.

The asset for version 0.0.6 is
`lunchbox-labs-opencode-config-composer-0.0.6.tgz`. It contains published plugin files
and metadata, but **does not bundle runtime dependencies** such as ajv, jsonc-parser,
and yaml. Install through npm to resolve dependencies:

```sh
npm install ./lunchbox-labs-opencode-config-composer-0.0.6.tgz
```

This is not a standalone or fully offline installation bundle. Registry propagation
is retried for about two minutes before attachment. Logs identify the lifecycle stage
without exposing credentials or response bodies.

The existing immutable 0.0.5 release cannot receive assets. Use the
[npm package](https://www.npmjs.com/package/@lunchbox-labs/opencode-config-composer/v/0.0.5)
or [published tarball](https://registry.npmjs.org/@lunchbox-labs/opencode-config-composer/-/opencode-config-composer-0.0.5.tgz).
