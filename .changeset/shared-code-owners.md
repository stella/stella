---
"@stll/business-registries": patch
"@stll/cli": patch
"@stll/money": patch
"@stll/template-conditions": patch
"@stll/ui": patch
---

Narrow values with type guards instead of type assertions, and give internal CLI helpers names that describe what they hold. `mapEntityStatus` now reads only the codes its mapping declares, so an inherited object key maps to `unknown`.
