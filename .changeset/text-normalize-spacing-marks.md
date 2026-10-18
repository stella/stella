---
"@stll/text-normalize": patch
---

`stripDiacritics`, `foldToAscii`, and `foldSearchMatchText` keep non-Latin spacing marks such as `ー` and `·` instead of deleting them.
