---
"@stll/ui": minor
"@stll/workspace-ui": minor
---

`@stll/ui/inline-overflow` holds the policy that decides which items of a single-line row fit and which move into a trailing "show more" menu (`resolveInlineOverflow`, `splitInlineOverflow`), and `@stll/ui/use-inline-overflow` measures a row for it. `InspectorFacetBar` runs on them. `WorkspaceViewSwitcher` takes a required `overflowLabel` and moves the views that do not fit into a menu after the tabs, keeping the active or renamed view on screen, instead of scrolling the tabs; the strip's add control no longer draws a divider.
