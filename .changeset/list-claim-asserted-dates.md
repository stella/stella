---
"@stll/cli": patch
---

`lists.verifications.get` claims carry `assertedOn`: the date the claim's words give, as `dated` with a `day`, `month` or `year` precision (stored as its first day) and its `source` (the words, or the grader when they name no complete date), or `none`. A re-check records its own reading.
