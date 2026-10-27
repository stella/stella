---
"@stll/ui": minor
---

`KanbanCardShell` takes `selected` and `onSelectionClick`: a selected card draws the selection ring, and a Cmd/Ctrl- or Shift-click reports its modifiers instead of opening the card. `registerKanbanCardDrag` takes `getDragPreview` to draw a custom preview, such as a stack for several cards. Cards and column headers carry `data-kanban-card` and `data-kanban-column-header` markers.
