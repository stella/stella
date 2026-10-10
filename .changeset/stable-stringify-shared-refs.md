---
"@stll/stable-stringify": patch
---

Serialize repeated non-circular references in full; only true cycles use the cycle marker, which is no longer a valid JSON value.
