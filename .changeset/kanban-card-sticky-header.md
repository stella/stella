---
"@stll/ui": minor
---

A card taller than the board it scrolls through keeps saying which card it is. `KanbanCardShell` takes a `stickyHeader` slot: whatever identifies the card (a code, a title) leads the card, pins under the chrome above it while the rest of the card passes behind it, and releases where the card ends, so the next card's row takes over. The slot is marked `data-kanban-card-sticky-header=""`, repaints the card's own surface over the card's own divider weight, and a card given none renders exactly as before. `KanbanVirtualCell` composes the offset the row rests at: the board's own `KANBAN_STICKY_TOP_VAR` plus the measured height of the cell's pinned action, published per row as `KANBAN_CARD_STICKY_TOP_VAR` (`--kanban-card-sticky-top`) with the virtualizer's own translation taken back out, since a transform between a sticky box and its scroll container is resolved in the translated space.
