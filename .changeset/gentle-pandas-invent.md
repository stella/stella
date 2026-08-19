---
"@stll/workspace-inspector": minor
---

Publish the workspace inspector's reusable chrome as `@stll/workspace-inspector`.

The dockable pane pattern — width arithmetic that never starves the content
column, a spacer-backed fixed overlay with a drag handle, and the
fixed-height key/value rows — was app-local to `apps/web`. It is now a
standalone package with no workspace dependency, so other products can
render the same component family instead of approximating it.

`apps/web` keeps its behaviour: `-inspector-pane-width.ts` is now a thin
binding that supplies Stella's sidebar sizing to the extracted policy.
