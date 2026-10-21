# Publishing Config Composer

Keep package.json and its lockfile version aligned, merge the intended commit to main,
then create and publish a stable GitHub release with a matching `vX.Y.Z` tag. Publishing
the release triggers the `Publish` workflow. Prereleases do not publish to npm.

The workflow checks out the existing tag, requires that commit to be on main, validates
package identity/version/access, and runs the full checks and native tests. It packs
that verified build and uploads the tarball plus SHA-256 checksum as an Actions artifact
retained for three days. The npm job downloads that artifact, verifies the checksum,
and publishes with npm OIDC trusted publishing under the existing `npm` environment.
Keep the npm trusted publisher configured for this repository and publish.yml workflow.

There is no manual workflow trigger or tag input. For recovery, investigate the failure
and rerun the failed jobs from the original release-triggered run. If npm publication
already succeeded, publishing the same version again fails; nothing is force-published
or overwritten.

The workflow does not create or move tags, create or publish GitHub releases, generate
release notes, or attach assets to releases. GitHub release content is managed by the
operator. The workflow requires only the existing npm trusted-publishing setup.
This rollback does not perform any remote cleanup.

Download the verified build from the Actions run artifact while it is retained. The
tarball contains plugin files and metadata, not bundled runtime dependencies; install
it through npm so those dependencies are resolved. It is not a standalone offline bundle.

The existing `v0.0.6` tag predates this rollback and points to the previous workflow
commit. Before releasing, the operator must either recreate the still-unpublished
tag at the intended rollback merge commit, or use a new version and matching tag.
This change does neither; publishing a release for an old tag verifies and publishes
that old tagged package, not the new main checkout.
