# @stll/workspace-model

## 0.3.0

### Minor Changes

- [#2794](https://github.com/stella/stella/pull/2794) [`6e437b5`](https://github.com/stella/stella/commit/6e437b5eca2beba037c380a8a7475055df41c0f3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Kanban column bands: a select property's options can belong to named groups,
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

## 0.2.0

### Minor Changes

- [#2559](https://github.com/stella/stella/pull/2559) [`3987cd1`](https://github.com/stella/stella/commit/3987cd1a03300035e261b2bd6a4c9804789adc52) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the Kanban sub-group property in the published workspace view model.

## 0.1.0

### Minor Changes

- [#2302](https://github.com/stella/stella/pull/2302) [`7eeb560`](https://github.com/stella/stella/commit/7eeb5600fc2f2b02e9c1c7a0a8570aca65ac9ff6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish portable typed property definitions, options, and values for entity workspaces.

- [#2303](https://github.com/stella/stella/pull/2303) [`cc41ad0`](https://github.com/stella/stella/commit/cc41ad05932cc8b80bb70489b239379d8b6b14f4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add saved table, kanban, calendar, and timeline view contracts over one entity collection.

### Patch Changes

- Updated dependencies [[`cee8359`](https://github.com/stella/stella/commit/cee8359ba613f0d16035765d352cc40121a971b1)]:
  - @stll/calculations@0.1.0
