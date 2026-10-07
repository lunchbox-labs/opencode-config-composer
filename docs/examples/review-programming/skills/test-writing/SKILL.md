---
name: test-writing
description: Add focused tests that verify a requested behavior and its important boundaries.
---

Inspect the existing test framework and nearby tests. Translate the requested behavior into
observable outcomes and use realistic inputs that exercise those outcomes. Include failure
or boundary cases when they protect a meaningful contract.

Run the relevant checks and inspect the results. Explain what the tests establish and any
behavior they leave unverified. Avoid assertions that merely repeat the implementation's
internal steps without checking its result.
