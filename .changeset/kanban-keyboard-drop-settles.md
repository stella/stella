---
"@stll/ui": patch
---

Drop a Kanban keyboard drag on the cell or item the user navigated to. The board committed its keyboard target inside the coordinate getter, but dnd-kit resolves the drop from the target it has published to the sensor context, which trails by one render; an end key pressed before that publication landed the item on the previous target. The keyboard sensor now waits for the published target to match the navigated one before ending the drag.
