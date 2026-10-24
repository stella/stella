---
"@stll/cli": patch
---

Document uploads read their PUT timeout from the shared upload contract, so the CLI and the API agree on how long an upload may run and still be finalized.
