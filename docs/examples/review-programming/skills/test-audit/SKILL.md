---
name: test-audit
description: Compare a change's intended behavior with its existing test coverage.
---

Identify the behavior introduced or changed, then inspect the tests that exercise it.
Check ordinary inputs, important boundaries, failure paths, and interactions with existing
behavior. Assess whether the assertions could detect a regression in the relevant contract.

Report uncovered behavior with a concrete example and the kind of test that would verify
it. Distinguish tests you inspected from tests you ran, and include the actual result of
any checks performed.
