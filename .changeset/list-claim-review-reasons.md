---
"@stll/cli": patch
---

`lists.verifications.claim-reviews.create` requires `reason` on `override`, `reopen` and `record-conflict` actions and takes an optional one on `status`, which can now also be `needs-evidence` (open until the record can answer it; never accepted in bulk). `lists.verifications.claim-reviews.list` reads a verification's review history, newest first: who acted, when, the action, its reason, and the claim's disposition just before and after, filterable by claim, action kind and reviewer.
