---
"@stll/ui": minor
---

`formatFileSize` writes sizes under 1 kB with the long, plural-aware unit ("333 bytes", "333 bajtů") instead of the short English unit, which has no plural ("333 byte"). Larger sizes keep the short units.

The `format` argument now receives `unitDisplay: "long"` for bytes, so a formatter passed in must accept `"long" | "short"`.
