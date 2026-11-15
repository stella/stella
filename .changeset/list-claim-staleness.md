---
"@stll/cli": patch
---

Add `lists.verifications.claim-rechecks.bulk.create`: checks several claims of one verification again in one request, each under its own request key, and reports each claim's outcome. `lists.verifications.get` claims carry `staleness`, the reasons a claim's grade may no longer stand on the list as it is now.
