---
name: code-review
description: Review a code change for concrete correctness and maintainability issues.
---

Read the changed code and the nearby callers before assessing its behavior. Trace inputs,
state changes, and error handling through the relevant paths. Check that the implementation
matches the requested behavior and preserves the repository's documented contracts.

For each finding, describe the triggering condition, observed or expected impact, and the
smallest useful correction. Cite the relevant file and line. Separate confirmed defects
from questions that need more evidence, and report when no concrete issue was found.
