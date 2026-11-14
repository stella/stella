---
"@stll/cli": patch
---

`tasks.create` accepts an idempotency key: a retried create with the same key returns the first task or list item instead of creating another.
