---
"@stll/anonymize-chat": patch
"@stll/ui": patch
"@stll/business-registries": patch
---

Invalid input now raises a tagged error (`ChatAnonInputLimitError` in anonymize-chat) or a `Panic` (resource calendar) instead of a native `RangeError` or `TypeError`.
