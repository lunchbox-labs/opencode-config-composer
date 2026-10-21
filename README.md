# OpenCode Config Composer

Compose OpenCode configuration with reusable groups, presets and profiles to switch models and permissions
across your agents. Manage selections, edit settings and inspect the result through `/compose-configs`.

Package: **`@lunchbox-labs/opencode-config-composer`** · Tested host range: **OpenCode V1 1.19.x**.
Independently maintained; not affiliated with OpenCode or Anomaly.

## Add Composer

Choose a published version from [Downloads](https://github.com/lunchbox-labs/opencode-config-composer/wiki/Downloads), then replace `VERSION` below.
Add the package to `plugin` in both `opencode.jsonc` and `tui.jsonc`:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-config-composer@VERSION"] }
```

The editors need the server plugin registered in the shared `opencode.jsonc`, even when the Composer
configuration lives in a project.

Register Config Composer before any plugin that transforms agent prompt or command template bodies.
This lets it resolve configuration and agent availability before the other plugin processes the resulting
bodies. Downstream body changes preserve Config Composer’s editor baseline; running a transformer first
can make that baseline differ from the authored native inputs.

You can download a verified build from its Actions run artifact while it is retained.
The tarball contains plugin files and metadata, not bundled runtime dependencies; install it
through npm so those dependencies are resolved. It is not a standalone offline bundle.

## Documentation

- [User Guide](https://github.com/lunchbox-labs/opencode-config-composer/wiki/User-Guide)
- [Configuration Reference](https://github.com/lunchbox-labs/opencode-config-composer/wiki/Configuration-Reference)
- [Component References](https://github.com/lunchbox-labs/opencode-config-composer/wiki/Component-References)
- [Integration Tests](https://github.com/lunchbox-labs/opencode-config-composer/wiki/Integration-Tests)
- [Example Provider Profiles](https://github.com/lunchbox-labs/opencode-config-composer/wiki/Example-Provider-Profiles)
- [Example Role Permissions](https://github.com/lunchbox-labs/opencode-config-composer/wiki/Example-Role-Permissions)
- [Example Review Programming](https://github.com/lunchbox-labs/opencode-config-composer/wiki/Example-Review-Programming)
- [Example Project Selection](https://github.com/lunchbox-labs/opencode-config-composer/wiki/Example-Project-Selection)

This project is licensed under MIT. See [LICENSE](LICENSE).
