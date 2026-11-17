---
"@stll/cli": major
---

Require `expectedUpdatedAt` when replacing a workflow definition with `flows.update`. Read the definition with `flows.get` and send its `updatedAt` value with the edited fields. A stale version returns `version_conflict` without changing the workflow; read the current definition and reconcile the intended changes before submitting again. Successful updates return the new `updatedAt` value.
