---
"@stll/chat": minor
"@stll/workspace-ui": patch
---

`ChatModelSelector` now renders the `@stll/ui` select (a button and a popup list) instead of a native `<select>`: a host must load the `@stll/ui` stylesheet (`@stll/ui/theme.css` with Tailwind scanning `@stll/ui`) for it to draw. `ChatLink` shows its new-tab notice or source title as a tooltip and as the link's accessible description. The condition builder's number fields use `NumberInput` without locale grouping.
