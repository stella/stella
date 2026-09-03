---
"@stll/ui": minor
---

A lane's controls stay reachable while its cells scroll. `KanbanSubgroupBoard` measures its sticky header block and publishes the reach on its scroll container as `KANBAN_STICKY_TOP_VAR` (`--kanban-sticky-top`), so anything that must stay readable rests just under the header and releases where its lane ends. `KanbanVirtualCell` takes `footerPlacement="sticky-start"`, which leads the rows with the `footer` and pins it there instead of closing the cell with it (marked `data-kanban-cell-footer="sticky-start"`, repainting the cell's own surface, accent wash included, over an opaque base so cards pass behind it), and the new `KanbanCollapsedBandCaption` keeps a folded band's name and count in view down a lane hundreds of cards tall. A cell that keeps its own bounded scroll surface is its own scroll container, where the board's header offset means nothing: reset the variable on such a cell so its action rests at the cell's own top.
