---
"@stll/ui": patch
---

A folded kanban band peeks open only while a card is being dragged over it: a plain hover, a column reorder drag, or any other native drag passing over the board no longer opens it, and a board that drives its own drag-and-drop (for example dnd-kit) can now report its drag directly to open the peek instead of relying on native drag events.
