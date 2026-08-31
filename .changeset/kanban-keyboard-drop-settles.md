---
"@stll/ui": patch
---

Drop a Kanban drag on the cell or item the pointer, touch, or keyboard actually reached. dnd-kit computes collisions while rendering but publishes the resulting drop target a render later, and resolves a drop from that published value; because a single move produces a single render, a drag that ended right after its last move landed the item on the previous target. Every board sensor now waits for the published target to match the computed collision before ending the drag.
