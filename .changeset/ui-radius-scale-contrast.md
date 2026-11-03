---
"@stll/ui": patch
"@stll/workspace-ui": minor
---

Corner radii name a scale step: bare `rounded` is now `rounded-sm`, and the checkbox, segmented toggle and input-group keycap use scale steps instead of pixel radii. `--radius` is 0.5rem. Light text is neutral-900, dark muted text neutral-400, and sidebar text is stronger in both themes.

`@stll/workspace-ui`: `./field-value#getIntClassName` returns the kanban class string with `rounded-sm` in place of `rounded`, so its literal return type changes.
