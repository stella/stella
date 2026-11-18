---
"@stll/ui": minor
---

Move inspector width persistence to the host application. Supply `initialWidth` for the server snapshot and `onWidthChange` to persist completed resizes; the hook no longer accepts `storageKey` or reads browser storage. Remove the browser-storage width helpers.

Expose `@stll/ui/pane-width` for width constants and calculations without importing inspector components.
