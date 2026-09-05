---
"@stll/cli": patch
---

The registry cache fingerprints tool schemas through `@stll/stable-stringify` instead of a private copy. Key order and output are unchanged, so cached deltas stay valid.
