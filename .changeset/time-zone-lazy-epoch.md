---
"@stll/time": patch
---

Importing `@stll/time` no longer calls `Temporal` at module load, so it loads where the runtime's `Temporal` is partial.
