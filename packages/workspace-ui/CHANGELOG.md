# @stll/workspace-ui

## 0.7.1

### Patch Changes

- Updated dependencies [[`45b076c`](https://github.com/stella/stella/commit/45b076ca5ea2c97b1534e7ee2493b0272064194b), [`67baa75`](https://github.com/stella/stella/commit/67baa75ca462fdb72ef9709e7dd3c7752a03411f), [`af89254`](https://github.com/stella/stella/commit/af89254e3173eec3551f027f12fe1490624670b5), [`6fb442a`](https://github.com/stella/stella/commit/6fb442ad7da2a21f7540e06029086bd04ee559a8)]:
  - @stll/conditions@0.3.0
  - @stll/ui@0.18.0

## 0.7.0

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

### Patch Changes

- Updated dependencies [[`6e437b5`](https://github.com/stella/stella/commit/6e437b5eca2beba037c380a8a7475055df41c0f3)]:
  - @stll/ui@0.17.0

## 0.6.3

### Patch Changes

- [#2706](https://github.com/stella/stella/pull/2706) [`6dd0e90`](https://github.com/stella/stella/commit/6dd0e90c14e0fc39d15783c78a605b61f1e8a8ba) Thanks [@dependabot](https://github.com/apps/dependabot)! - Update TanStack Table to 9.2.3, preserving filter metadata and parent-first flattened rows for hierarchical tables.
- Updated dependencies [[`0aeaa0f`](https://github.com/stella/stella/commit/0aeaa0f1fab5c562d153dce4338e2c039afb86b6)]:
  - @stll/ui@0.16.1

## 0.6.2

### Patch Changes

- Updated dependencies [[`baa8677`](https://github.com/stella/stella/commit/baa86771abbe8e7f50d1ced611a434328a478b3c), [`0e93dee`](https://github.com/stella/stella/commit/0e93deec1bcf1284fe6b61fe24dde916ee53b29d)]:
  - @stll/ui@0.16.0

## 0.6.1

### Patch Changes

- [#2753](https://github.com/stella/stella/pull/2753) [`b709089`](https://github.com/stella/stella/commit/b7090892e514550b1599b344823f63ca0854bb06) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Render one responsive inspector presentation at a time in the complete workspace frame.
- Updated dependencies [[`23c39cf`](https://github.com/stella/stella/commit/23c39cf74812da26020e97b7c9a9ce12259ea707), [`0751826`](https://github.com/stella/stella/commit/0751826516062111ad9491b95aaad9ee86878a36)]:
  - @stll/ui@0.15.0

## 0.6.0

### Minor Changes

- [#2733](https://github.com/stella/stella/pull/2733) [`e1f2d5c`](https://github.com/stella/stella/commit/e1f2d5c72d266783f757bc0f99c17719f9798dd0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a descriptor-driven workspace frame that owns application navigation and inspector chrome.

### Patch Changes

- Updated dependencies [[`81da3b3`](https://github.com/stella/stella/commit/81da3b39ec8044e9398ee4c01f7bbbdd9a36de36), [`e1f2d5c`](https://github.com/stella/stella/commit/e1f2d5c72d266783f757bc0f99c17719f9798dd0)]:
  - @stll/ui@0.14.0

## 0.5.2

### Patch Changes

- [#2718](https://github.com/stella/stella/pull/2718) [`3ba47d9`](https://github.com/stella/stella/commit/3ba47d972edf440db68e290d0d1f30c7ab66e8f7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Hide native scrollbar chrome while retaining horizontal overflow in responsive action toolbars.

- [#2717](https://github.com/stella/stella/pull/2717) [`ee35cfa`](https://github.com/stella/stella/commit/ee35cfa57dac2a87187f9451f53e5d40b2aaf683) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep actions attached to a workspace view tab aligned with its label.

## 0.5.1

### Patch Changes

- Updated dependencies [[`5a4fa91`](https://github.com/stella/stella/commit/5a4fa911178e25717079e00d048d3a38daf50e7b)]:
  - @stll/ui@0.13.0

## 0.5.0

### Minor Changes

- [#2668](https://github.com/stella/stella/pull/2668) [`e72a4f2`](https://github.com/stella/stella/commit/e72a4f277e6bf76b558d8f5f1bf4db286fc18929) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the responsive action toolbar for compact workspace controls and allow
  single-purpose shells to omit a compact navigation trigger.

### Patch Changes

- Updated dependencies [[`fb97db5`](https://github.com/stella/stella/commit/fb97db59eb4756fd6b0bd82ce42c3016d6946d66), [`e72a4f2`](https://github.com/stella/stella/commit/e72a4f277e6bf76b558d8f5f1bf4db286fc18929)]:
  - @stll/ui@0.12.1

## 0.4.4

### Patch Changes

- Updated dependencies [[`58c51a3`](https://github.com/stella/stella/commit/58c51a3018ca64ed898e1598b1daba6fe7a71bc8), [`88bf7fb`](https://github.com/stella/stella/commit/88bf7fb898ece322c3b7d2aa015dcb7b5d1da8a8), [`00bd34d`](https://github.com/stella/stella/commit/00bd34d7b6d4204749730813ae2cde4a2e82047e), [`0b7892b`](https://github.com/stella/stella/commit/0b7892bd9b3b440db2da3604ca05c806d458e98f)]:
  - @stll/ui@0.12.0

## 0.4.3

### Patch Changes

- Updated dependencies [[`c56a0c7`](https://github.com/stella/stella/commit/c56a0c7e97ef276b1353a7621e4658b2d9f2ada0)]:
  - @stll/ui@0.11.0

## 0.4.2

### Patch Changes

- Updated dependencies [[`37b6437`](https://github.com/stella/stella/commit/37b64377f9806be3da0a9cf9b33e7b984e46ed1a)]:
  - @stll/ui@0.10.0

## 0.4.1

### Patch Changes

- [#2561](https://github.com/stella/stella/pull/2561) [`12c66de`](https://github.com/stella/stella/commit/12c66de9a101424ff6b93f8fc8359ebcc5f18e33) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Preserve a board's group identifier union through grouping, saved-view, picker, and atomic drop-intent APIs.
- Updated dependencies [[`12c66de`](https://github.com/stella/stella/commit/12c66de9a101424ff6b93f8fc8359ebcc5f18e33)]:
  - @stll/ui@0.9.1

## 0.4.0

### Minor Changes

- [#2533](https://github.com/stella/stella/pull/2533) [`e25afb5`](https://github.com/stella/stella/commit/e25afb5a513b7dc76d8ad692245af452685c4eff) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add typed Group and Sub-group board matrices, reusable swimlane and virtual-cell renderers, atomic drop intents, and persisted board-presentation adapters.

### Patch Changes

- Updated dependencies [[`e25afb5`](https://github.com/stella/stella/commit/e25afb5a513b7dc76d8ad692245af452685c4eff)]:
  - @stll/ui@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`7c0d6fb`](https://github.com/stella/stella/commit/7c0d6fb9003b917202449450bdfd7362d4089bfb), [`a4062b2`](https://github.com/stella/stella/commit/a4062b260031fe8fda587ea7e8bf2e2841349523), [`9c2cc2d`](https://github.com/stella/stella/commit/9c2cc2daff89dda2cc2508e2c1dca6bde834dc57)]:
  - @stll/ui@0.8.0

## 0.3.2

### Patch Changes

- [#2526](https://github.com/stella/stella/pull/2526) [`355d6c1`](https://github.com/stella/stella/commit/355d6c1e48fef5d15f15435bd9ce26a0f88b4b2e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - - @stll/auth-model: Require a verified email address before an organization invitation grants access.
  - @stll/cli: Regenerate the route map for the `properties.preview` capability's access and scope.
  - @stll/workspace-ui: Load person avatar images lazily and without a referrer.
- Updated dependencies [[`746d6f3`](https://github.com/stella/stella/commit/746d6f3ecee8e92aa433bc4b30c5507ed5e3bb53), [`62e2d3e`](https://github.com/stella/stella/commit/62e2d3eda8809f5cd6996cb6e3b1515cd18da1f2)]:
  - @stll/ui@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`26acf32`](https://github.com/stella/stella/commit/26acf32c18edbcd71ebc3f29ba2999676bc90390), [`7f66d10`](https://github.com/stella/stella/commit/7f66d10919fee6037d16fac69a1dff08125cffb8)]:
  - @stll/ui@0.6.0

## 0.3.0

### Minor Changes

- [#2338](https://github.com/stella/stella/pull/2338) [`f9dc04a`](https://github.com/stella/stella/commit/f9dc04afa5045c757a57a31938554a32bde6f984) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an optional `maxChildren` cap to the condition builder's capabilities; refresh the capability catalog with the bounded request filter arrays.

- [#2333](https://github.com/stella/stella/pull/2333) [`60a11f4`](https://github.com/stella/stella/commit/60a11f4d18e38870f02882ef41a6d39b925eb343) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an optional `maxSorts` cap to `SortChips`; refresh the capability catalog with the separate view-sort bound and the raised property cap.

### Patch Changes

- Updated dependencies [[`3bf2e63`](https://github.com/stella/stella/commit/3bf2e63080436a16dad0a46958049850ec5831c4)]:
  - @stll/ui@0.5.1

## 0.2.1

### Patch Changes

- Updated dependencies [[`f43667b`](https://github.com/stella/stella/commit/f43667bfa8dccca5f4c4e622bf6f80972ed349d6)]:
  - @stll/ui@0.5.0

## 0.2.0

### Minor Changes

- [#2322](https://github.com/stella/stella/pull/2322) [`2b1e874`](https://github.com/stella/stella/commit/2b1e87435afbcc9ebdf1aa2e2e46d2ca4a07cf5f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish a controlled, accessible saved-view switcher with bidi-aware reordering.

## 0.1.0

### Minor Changes

- [#2296](https://github.com/stella/stella/pull/2296) [`cee8359`](https://github.com/stella/stella/commit/cee8359ba613f0d16035765d352cc40121a971b1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish the reusable money, calculation, and workspace presentation packages
  with explicit build and export contracts.

### Patch Changes

- Updated dependencies [[`77825df`](https://github.com/stella/stella/commit/77825dfdee54a9d3b065afa3b5504aaa55050bd8), [`d2dcd0f`](https://github.com/stella/stella/commit/d2dcd0f1df22dffc91ba779e6c278b18825f1932), [`cee8359`](https://github.com/stella/stella/commit/cee8359ba613f0d16035765d352cc40121a971b1)]:
  - @stll/ui@0.4.0
  - @stll/money@0.1.0
  - @stll/calculations@0.1.0
