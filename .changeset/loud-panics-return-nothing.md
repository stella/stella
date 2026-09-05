---
"@stll/business-registries": patch
"@stll/calculations": patch
"@stll/chat": patch
"@stll/cli": patch
"@stll/conditions": patch
"@stll/ssr-kit": patch
"@stll/template-conditions": patch
"@stll/ui": patch
"@stll/workspace-ui": patch
---

Exhaustiveness checks panic instead of returning the unhandled value, and a
fallback after the assertion counts as returning it.
