---
"@stll/ui": minor
"@stll/workspace-ui": patch
---

`@stll/ui/directional-controls` exports `stripDirectionalControls` from a module with no imports, so code outside the design system can share it; `@stll/ui/bidi-text` re-exports it as before. `ViewSwitcher` renders view names isolated and without directional controls.
