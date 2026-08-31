---
"@stll/ui": patch
---

Drop a Kanban drag on the cell or item the pointer, touch, or keyboard actually reached. dnd-kit computes collisions while rendering but publishes the resulting drop target a render later, and resolves a drop from that published value; because a single move produces a single render, a drag that ended right after its last move landed the item on the previous target. Every board sensor now waits for the published target to match the computed collision before ending the drag.

Keyboard navigation to a row a virtual cell has not mounted yet is held to the same rule: ending while that row is still being scrolled into view waits for it rather than committing the row the drag had left, and cancels instead of dropping somewhere the user never navigated to if the board cannot reach it.
