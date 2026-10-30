---
"@stll/fetch": minor
---

Return the transport's own `Response` for every timeout policy, remove the misleading transport-level `idle` policy, and add an explicit idle-bounded body reader that restarts its deadline for each chunk.
