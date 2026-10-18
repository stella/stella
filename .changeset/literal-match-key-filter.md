---
"@stll/text-normalize": minor
---

Expose literal substring matching and bounded UTF-16 match ranges for caller-prepared search keys.

Replace lone surrogates with U+FFFD on both sides before match-key searches, retaining UTF-16 offsets.
