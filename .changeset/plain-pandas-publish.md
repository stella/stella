---
"@stll/stable-stringify": minor
---

First release. `stableStringify` gives JSON-shaped values a deterministic string form for fingerprints and cache keys: keys sort in UTF-16 code-unit order, so the output is identical across runtimes and locales. `StableStringifyInput` states the input contract, keeping a `Date`, `Map`, or `Set` — each of which would serialize as `{}` and collide — a compile error at the call site.
