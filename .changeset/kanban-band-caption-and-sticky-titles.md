---
"@stll/ui": minor
---

A kanban band caption now reads as the parent of the columns it groups: its
line stands on the same row height as the column headers and sets the band's
name a step heavier than a column title, instead of a shorter line with a
smaller label that left a group looking subordinate to its own columns. Folded,
the band's vertical caption keeps that weight.
`KANBAN_BAND_CAPTION_ROW_HEIGHT` is now the chrome row height.

A column title also stays readable while its column scrolls past: the swatch,
the name and the count hold the visible inline edge of a board scrolled
sideways until the column itself is gone, so the cards under it are never left
unlabelled. The title travels only as far as the row's own controls, which stay
at the end of the row, and takes no surface of its own, so the accent a caller
washes a header cell with goes on painting under it.

A card's pinned identity row takes a stacking layer, so the positioned controls
a card carries lower in its own body no longer paint over the name of the card
they belong to while it scrolls out. The shell's hover actions share that layer
and still win on tree order; a caller anchoring its own always-visible overlay
to the same corner now needs a layer of its own.

`WorkspaceShell` pins its top bar at the new `SHELL_CHROME_LAYER_CLASS_NAME`
(`z-30`), above the sticky chrome a view pins inside the shell's own scroller.
A board's header sits at `z-20` and its lane rows at `z-10`; when the shell's
content column rather than the board is the scroll container, the two used to
tie on z-index and paint order decided which one covered the other.
