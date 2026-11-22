---
"@stll/ui": patch
---

`formatFileSize` writes sizes under 1 kB with the long, plural-aware unit ("333 bytes", "333 bajtů") instead of the short English unit, which has no plural ("333 byte"). Larger sizes keep the short units.
