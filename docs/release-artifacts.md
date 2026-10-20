# Published npm release assets

For future releases, create the stable `vX.Y.Z` tag on main and a matching **draft**
GitHub release. Manually dispatch the publish workflow from main with that tag.
After verification, a read-only preflight requires an existing matching draft that
is stable and mutable before npm publication. The workflow never creates releases
or publishes drafts. Publish the draft yourself only after the attachment job succeeds.
Publishing first can make the release immutable and prevent asset attachment.

After npm publication, the attachment job downloads the exact version's `dist.tarball`
from npm, verifies the name/version, SHA-512 integrity (and supplied SHA-1 shasum), and
package.json identity inside the archive, then attaches those exact bytes to the draft.
It never repacks the checkout. Registry propagation is retried for up to two minutes.
Only the attachment job has contents write permission; preflight uses contents read.

For Config Composer 0.0.6 the filename is
`lunchbox-labs-opencode-config-composer-0.0.6.tgz`. The tarball contains published plugin
files and metadata, but does **not** bundle runtime dependencies such as ajv,
jsonc-parser, and yaml. Install through npm to resolve dependencies:

```sh
npm install ./lunchbox-labs-opencode-config-composer-0.0.6.tgz
```

This is not a standalone or fully offline installation bundle.

If attachment fails after npm publication, keep the release in draft and rerun only
that failed job. An existing same-name asset is accepted only when its bytes match;
mismatches fail without deletion or overwrite. A whole-workflow rerun will fail when
npm rejects the already-published version. There is no force-publish or version change.
The helper comes from the workflow commit; package identity comes from the verified tag.

The already-published immutable 0.0.5 release cannot be retrofitted with assets.
Use the [npm package](https://www.npmjs.com/package/@lunchbox-labs/opencode-config-composer/v/0.0.5)
or its [published tarball](https://registry.npmjs.org/@lunchbox-labs/opencode-config-composer/-/opencode-config-composer-0.0.5.tgz).

The corrected flow needs a new package version, 0.0.6; do not republish 0.0.5.
Draft release events do not trigger Actions, so this uses explicit manual dispatch
([GitHub event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)).
