---
"@stll/fetch": minor
---

Return the transport's own `Response` for every timeout policy and remove the misleading transport-level `idle` policy. The new `@stll/fetch/body-reader` export reads a body with an idle deadline that restarts for each chunk and an optional byte limit: `iterateBodyWithIdleDeadline`, `readBodyWithIdleDeadline`, `readBodyTextWithIdleDeadline`, `readBodyJsonWithIdleDeadline` and `BodyByteLimitError`.
