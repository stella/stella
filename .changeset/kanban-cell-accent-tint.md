---
"@stll/ui": minor
---

Add an optional `accent` prop to `KanbanVirtualCell` (`@stll/ui/kanban`) so a host can carry a column's option colour onto the cell surface itself, not just its header swatch. With no `accent`, the surface renders exactly as before. With an `accent`, the resting surface gets a faint colour-derived tint, and while `active` is also set (a card dragged over the cell) the tint strengthens into an accent-coloured wash and ring, replacing the generic highlight instead of layering under it.
