---
"@stll/cli": patch
---

Add `lists.verifications.claim-rechecks.create`: checks one verified claim again against the list's current facts and records the new grade as a review event, leaving the run's claim unchanged. Claim reviews accept `fact-link` to link or unlink a fact of the verified list, and the review history lists links and re-checks.
