---
"@stll/ui": minor
---

Export the kanban board's grouping and the option-colour token.

`@stll/ui/kanban` carries the board's column resolution and its two pieces of
chrome. A board's columns come from a schema the caller supplies: the properties
it may group by, plus built-in group resolvers for columns that come from
somewhere other than a property. The module reads nothing off a row, so what a
row is stays entirely with the caller. Alongside it, `KanbanCardShell` holds the
card's border, hover lift, active ring and drag wrapper, and
`KanbanColumnHeader` holds the header row's rhythm; a card that opens nothing
gets neither a button role nor a tab stop.

`@stll/ui/option-color` is the colour token user-chosen options are stored as:
one of sixteen named presets resolving to the theme's `--option-*` custom
properties, or a hex string resolving to a `color-mix` against the current
background. The indirection is what keeps a stored colour theme-aware, and the
resolver had been written out twice outside the package.
