---
"@stll/cli": patch
"@stll/ui": patch
"@stll/business-registries": patch
"@stll/template-conditions": patch
"@stll/workspace-ui": patch
---

Use Temporal for calendar calculations and wall clocks, with a native implementation when available and a bundled fallback otherwise. Preserve serialized timestamps and existing Date-based library interfaces.
