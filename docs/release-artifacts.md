# Published npm release assets

After a successful npm publication, the release workflow downloads the exact version's
`dist.tarball` from the npm registry and attaches it to the existing matching published
GitHub release. For Config Composer 0.0.5, the asset is named
`lunchbox-labs-opencode-config-composer-0.0.5.tgz`.

The attachment job verifies the registry's package name/version, SHA-512 integrity
(and SHA-1 shasum when supplied), and the package.json identity inside the downloaded
archive. It never repacks the checkout or substitutes the earlier workflow artifact.
The tarball contains the published plugin files and metadata; it does **not** bundle
runtime dependencies such as ajv, jsonc-parser, and yaml. Install it through npm so
those dependencies are resolved, for example:

```sh
npm install ./lunchbox-labs-opencode-config-composer-0.0.5.tgz
```

This asset is not a standalone or fully offline installation bundle.

A separate post-publication job has the GitHub contents write permission. If attachment
fails after npm publication, rerun that failed job rather than publishing again. It
accepts an existing same-name asset only when its bytes exactly match the verified npm
archive; mismatches fail without deletion or overwrite. A concurrent same-name upload
is checked the same way. Registry metadata propagation is retried a bounded six times.
No GitHub release is created: manual dispatch requires an existing published stable
release whose tag exactly matches `v` plus the verified package version.

Rerunning the entire workflow retains the existing npm behavior: publishing an already
published version fails. There is no replacement, force-publish, or automatic version
change. The workflow source supplies the attachment helper when an older release tag
is manually selected, while the package identity still comes from that verified tag.
