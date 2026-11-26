---
"@stll/ui": patch
"@stll/workspace-ui": patch
---

`SidebarProvider`, `DetailsGrid`, `EntityActions`, the native `Sheet` and `ConditionBuilder` keep their context values stable across renders, so a re-render of the provider no longer re-renders every consumer in an app that does not use the React Compiler.
