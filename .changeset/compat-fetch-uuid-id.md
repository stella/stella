---
"@stll/cli": patch
---

The `fetch` tool declares its `id` input as a UUID. An id that is not UUID-shaped is now rejected as a validation error naming the field, instead of reaching the database and failing there as an opaque internal error.
