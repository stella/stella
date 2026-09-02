---
"@stll/workspace-model": minor
"@stll/ui": minor
"@stll/workspace-ui": minor
---

Kanban column bands: a select property's options can belong to named groups,
and the board shows a group's columns under one band header that folds into a
single narrow lane.

- `@stll/workspace-model`: `WorkspacePropertyOptionGroup`, `groups` on a
  select definition and `groupId` on an option, plus
  `resolveWorkspacePropertyOptionGroups`, which lays options out by group in
  sort order and reports an undeclared or split group instead of repairing it.
- `@stll/ui/kanban`: `KanbanColumnBand` on `KanbanGroupOption` and
  `KanbanGroup`; `resolveKanbanColumnBands` (contiguous runs, rejects a band
  that resumes after another column); `KanbanColumnBandHeader`; and
  `KanbanSubgroupBoard` renders band headers over banded columns, folds a
  collapsed band into one slot per row whose hidden cells stay reachable
  through `renderCollapsedBandCell`, peeks a folded band open while a pointer
  rests on it, and accepts controlled collapse through `isBandCollapsed` /
  `onBandCollapsedChange`. The column width and gap are now exported
  constants.
- `@stll/workspace-ui`: saved view state `version: 2` adds
  `group.collapsedBands`; `normalizeKanbanSavedViewState` lifts a version 1
  state; `presentKanbanBoard` returns the presented `bands` with the view's
  fold applied; `createWorkspaceKanbanSchema` carries an option's `band`
  through to its column.
