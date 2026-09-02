# @stll/ui

## 0.16.0

### Minor Changes

- [#2770](https://github.com/stella/stella/pull/2770) [`baa8677`](https://github.com/stella/stella/commit/baa86771abbe8e7f50d1ced611a434328a478b3c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `KanbanCellAction`, the shared full-width ghost row that ends a kanban cell with its add action, so every board renders the same footer.

### Patch Changes

- [#2769](https://github.com/stella/stella/pull/2769) [`0e93dee`](https://github.com/stella/stella/commit/0e93deec1bcf1284fe6b61fe24dde916ee53b29d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep combobox, select, and menu item content inside the popup: the content track now shrinks below its content so truncating children clip instead of widening the item.

## 0.15.0

### Minor Changes

- [#2750](https://github.com/stella/stella/pull/2750) [`0751826`](https://github.com/stella/stella/commit/0751826516062111ad9491b95aaad9ee86878a36) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a numeric input with separate editable and canonical values, and keep portal-backed select surfaces readable under dark color schemes.

### Patch Changes

- [#2754](https://github.com/stella/stella/pull/2754) [`23c39cf`](https://github.com/stella/stella/commit/23c39cf74812da26020e97b7c9a9ce12259ea707) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Render Kanban boards without a subgroup as a single row of typed cells.

## 0.14.0

### Minor Changes

- [#2733](https://github.com/stella/stella/pull/2733) [`e1f2d5c`](https://github.com/stella/stella/commit/e1f2d5c72d266783f757bc0f99c17719f9798dd0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a descriptor-driven workspace frame that owns application navigation and inspector chrome.

### Patch Changes

- [#2732](https://github.com/stella/stella/pull/2732) [`81da3b3`](https://github.com/stella/stella/commit/81da3b39ec8044e9398ee4c01f7bbbdd9a36de36) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose each Kanban swimlane cell's row count to the typed render-cell
  primitive, including explicit zero counts for empty intersections. Add typed
  terminal destination columns to the matrix and drop intent contract.

## 0.13.0

### Minor Changes

- [#2695](https://github.com/stella/stella/pull/2695) [`5a4fa91`](https://github.com/stella/stella/commit/5a4fa911178e25717079e00d048d3a38daf50e7b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Allow sortable Kanban boards to configure mouse drag activation distance while preserving the default touch and keyboard behavior.

## 0.12.1

### Patch Changes

- [#2661](https://github.com/stella/stella/pull/2661) [`fb97db5`](https://github.com/stella/stella/commit/fb97db59eb4756fd6b0bd82ce42c3016d6946d66) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep flex-based route content stretched inside the workspace shell scroller.

- [#2668](https://github.com/stella/stella/pull/2668) [`e72a4f2`](https://github.com/stella/stella/commit/e72a4f277e6bf76b558d8f5f1bf4db286fc18929) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the responsive action toolbar for compact workspace controls and allow
  single-purpose shells to omit a compact navigation trigger.

## 0.12.0

### Minor Changes

- [#2635](https://github.com/stella/stella/pull/2635) [`88bf7fb`](https://github.com/stella/stella/commit/88bf7fb898ece322c3b7d2aa015dcb7b5d1da8a8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a card drag surface that preserves embedded controls and scrolling while supporting whole-card drag activation.

- [#2573](https://github.com/stella/stella/pull/2573) [`0b7892b`](https://github.com/stella/stella/commit/0b7892bd9b3b440db2da3604ca05c806d458e98f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Let virtual Kanban cells own typed scroll-element drop targets and their sortable context. Add two-axis keyboard navigation, explicit item or handle activation, outside-board cancellation, overlay stacking, and pointer/touch auto-scroll defaults.

### Patch Changes

- [#2639](https://github.com/stella/stella/pull/2639) [`58c51a3`](https://github.com/stella/stella/commit/58c51a3018ca64ed898e1598b1daba6fe7a71bc8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Drop a Kanban drag on the cell or item the pointer, touch, or keyboard actually reached. dnd-kit computes collisions while rendering but publishes the resulting drop target a render later, and resolves a drop from that published value; because a single move produces a single render, a drag that ended right after its last move landed the item on the previous target. Every board sensor now waits for the published target to match the computed collision before ending the drag.

  Keyboard navigation to a row a virtual cell has not mounted yet is held to the same rule: ending while that row is still being scrolled into view waits for it rather than committing the row the drag had left, and cancels instead of dropping somewhere the user never navigated to if the board cannot reach it.

- [#2642](https://github.com/stella/stella/pull/2642) [`00bd34d`](https://github.com/stella/stella/commit/00bd34d7b6d4204749730813ae2cde4a2e82047e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Restore keyboard card dragging and preserve nested control input events.

## 0.11.1

### Patch Changes

- [#2589](https://github.com/stella/stella/pull/2589) [`1e696fb`](https://github.com/stella/stella/commit/1e696fbccf05cd26b899c161952c81ae323c4b80) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep Select's derived label callback stable across parent renders.

## 0.11.0

### Minor Changes

- [#2596](https://github.com/stella/stella/pull/2596) [`c56a0c7`](https://github.com/stella/stella/commit/c56a0c7e97ef276b1353a7621e4658b2d9f2ada0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Make responsive navigation ownership explicit in `WorkspaceShell`, with a shell-managed compact sheet contract for hosts that do not already provide responsive navigation.

## 0.10.0

### Minor Changes

- [#2594](https://github.com/stella/stella/pull/2594) [`37b6437`](https://github.com/stella/stella/commit/37b64377f9806be3da0a9cf9b33e7b984e46ed1a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Replace the partial application frame with a complete fixed-viewport workspace shell and permanent typed end rail. This pre-1.0 breaking minor requires navigation, sticky top chrome, and an inline-end dock; chat must be wired or explicitly unavailable.

## 0.9.1

### Patch Changes

- [#2561](https://github.com/stella/stella/pull/2561) [`12c66de`](https://github.com/stella/stella/commit/12c66de9a101424ff6b93f8fc8359ebcc5f18e33) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Preserve a board's group identifier union through grouping, saved-view, picker, and atomic drop-intent APIs.

## 0.9.0

### Minor Changes

- [#2533](https://github.com/stella/stella/pull/2533) [`e25afb5`](https://github.com/stella/stella/commit/e25afb5a513b7dc76d8ad692245af452685c4eff) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add typed Group and Sub-group board matrices, reusable swimlane and virtual-cell renderers, atomic drop intents, and persisted board-presentation adapters.

## 0.8.0

### Minor Changes

- [#2551](https://github.com/stella/stella/pull/2551) [`7c0d6fb`](https://github.com/stella/stella/commit/7c0d6fb9003b917202449450bdfd7362d4089bfb) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add reusable inspector tabs and compact application rails that share stella's dock sizing, scroll ownership, and sidebar control rhythm.

- [#2528](https://github.com/stella/stella/pull/2528) [`9c2cc2d`](https://github.com/stella/stella/commit/9c2cc2daff89dda2cc2508e2c1dca6bde834dc57) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export a shared ordered control-size contract and use it consistently across text inputs, textareas, selects, comboboxes, and command inputs.

### Patch Changes

- [#2538](https://github.com/stella/stella/pull/2538) [`a4062b2`](https://github.com/stella/stella/commit/a4062b260031fe8fda587ea7e8bf2e2841349523) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Allow application shell content to shrink within its flex layout.

## 0.7.0

### Minor Changes

- [#2524](https://github.com/stella/stella/pull/2524) [`746d6f3`](https://github.com/stella/stella/commit/746d6f3ecee8e92aa433bc4b30c5507ed5e3bb53) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the shared review chrome: status badge, severity dot, decision actions, comment card, author avatar, out-of-date notice, and diff text.

- [#2530](https://github.com/stella/stella/pull/2530) [`62e2d3e`](https://github.com/stella/stella/commit/62e2d3eda8809f5cd6996cb6e3b1515cd18da1f2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an `ApplicationShell` primitive for application navigation, page chrome, and optional inspector layouts.

## 0.6.0

### Minor Changes

- [#2502](https://github.com/stella/stella/pull/2502) [`26acf32`](https://github.com/stella/stella/commit/26acf32c18edbcd71ebc3f29ba2999676bc90390) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add accessible sortable-board primitives with pointer, touch, and keyboard input support.

- [#2431](https://github.com/stella/stella/pull/2431) [`7f66d10`](https://github.com/stella/stella/commit/7f66d10919fee6037d16fac69a1dff08125cffb8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the `Loader` and `LoaderState` primitives for indeterminate loading states, and restore bordered inspector rail tabs.

## 0.5.2

### Patch Changes

- [#2412](https://github.com/stella/stella/pull/2412) [`e152e00`](https://github.com/stella/stella/commit/e152e00d04ec923758e5cece8033c46f87469c48) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Render inspector rail tabs as canonical square active chips.

## 0.5.1

### Patch Changes

- [#2345](https://github.com/stella/stella/pull/2345) [`3bf2e63`](https://github.com/stella/stella/commit/3bf2e63080436a16dad0a46958049850ec5831c4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `use-latest` export; migrate internal render-body ref mirrors to it so affected components stay React Compiler-compatible.

## 0.5.0

### Minor Changes

- [#2327](https://github.com/stella/stella/pull/2327) [`f43667b`](https://github.com/stella/stella/commit/f43667bfa8dccca5f4c4e622bf6f80972ed349d6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an entity-agnostic data-table renderer with empty, loading, and accessible row-action states.

## 0.4.0

### Minor Changes

- [#2300](https://github.com/stella/stella/pull/2300) [`77825df`](https://github.com/stella/stella/commit/77825dfdee54a9d3b065afa3b5504aaa55050bd8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export entity-agnostic calendar primitives and a resource calendar with half-open date-range placement.

- [#2297](https://github.com/stella/stella/pull/2297) [`d2dcd0f`](https://github.com/stella/stella/commit/d2dcd0f1df22dffc91ba779e6c278b18825f1932) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export the kanban card drag lifecycle and horizontal board auto-scroll from
  `@stll/ui/kanban`. Card payloads and drop persistence stay with the application;
  the package owns the shared drag preview and overflow-boundary behaviour. The
  Atlaskit v3 is a peer contract, so drag sources, targets, and monitors share one
  adapter instance.

## 0.3.0

### Minor Changes

- [#2266](https://github.com/stella/stella/pull/2266) [`5388db6`](https://github.com/stella/stella/commit/5388db63ae1c431da728845f4ae5d1f89f927e18) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export the kanban board's grouping and the option-colour token.

  `@stll/ui/kanban` carries the board's column resolution and its two pieces of
  chrome. A board's columns come from a schema the caller supplies: the properties
  it may group by, plus built-in group resolvers for columns that come from
  somewhere other than a property. The module reads nothing off a row, so what a
  row is stays entirely with the caller. Alongside it, `KanbanCardShell` holds the
  card's border, hover lift, active ring and drag wrapper, and
  `KanbanColumnHeader` holds the header row's rhythm; a card that opens nothing
  gets neither a button role nor a tab stop.

  `@stll/ui/option-color` is the colour token user-chosen options are stored as:
  one of sixteen named presets resolving to the theme's `--option-*` custom
  properties, or a hex string resolving to a `color-mix` against the current
  background. The indirection is what keeps a stored colour theme-aware, and the
  resolver had been written out twice outside the package.

- [#2276](https://github.com/stella/stella/pull/2276) [`2f7f773`](https://github.com/stella/stella/commit/2f7f773f8b9c0a14511a796a40821a35943b3b13) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export the data table's column schema.

  `@stll/ui/data-table` describes what a table's columns are, independent of how
  they draw: an ordered list of descriptors, each with an id, a label, a starting
  width, its capabilities (sort, hide, resize, pin) and an emphasis. Nothing in it
  looks inside a descriptor's render payload, so a caller keeps its own
  exhaustively checked union there and the schema stays free of any idea about
  what a row holds.

  Two rules belong to the schema rather than to a renderer: a column that cannot
  be hidden stays visible whatever the stored hidden list says, so a stale list
  cannot strand a table without its selection column; and `duplicateColumnIds`
  reports a repeated id, which would otherwise drop a column silently because the
  table keys by id.

### Patch Changes

- [#2272](https://github.com/stella/stella/pull/2272) [`794eca0`](https://github.com/stella/stella/commit/794eca0b7d4d615d78f899b1629eff21831bd530) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Outline rail entries take an optional `title`, rendered after a non-truncating label; `meta` stays right-pinned. The tooltip shows both.

- [#2271](https://github.com/stella/stella/pull/2271) [`314a468`](https://github.com/stella/stella/commit/314a4685593298e63f017c466125b7348f9f9858) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Toggling an outline rail branch keeps the toggled row where it was instead of re-pinning it to its sticky offset.

## 0.2.0

### Minor Changes

- [#2260](https://github.com/stella/stella/pull/2260) [`9c7604a`](https://github.com/stella/stella/commit/9c7604a144b2566b0b27b0d81ba6c2d2cd63f213) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish the design system as a versioned package with an explicit export map.

  `@stll/ui` was a private workspace whose `exports` were wildcards over `./src`,
  so nothing checked that a module belonged in the design system: the boundary
  between reusable primitive and application code was a convention. It now
  declares one flat subpath per module — `@stll/ui/button`, `@stll/ui/use-mobile`,
  `@stll/ui/utils`, `@stll/ui/inspector` — plus `sideEffects: false` and peer
  dependencies on React, Base UI, and Tailwind, and builds with tsdown to one
  output module per source module with declarations.

  The grouped subpaths `@stll/ui/components/<name>`, `@stll/ui/hooks/<name>`, and
  `@stll/ui/lib/<name>` are deprecated. They still resolve to the same modules
  and will be removed after this minor.

  `@stll/ui/theme.css` is now the only stylesheet the package exports: the token
  map, the palettes, the base layer, and the custom utilities. No compiled CSS
  ships, and each application owns its own Tailwind entry rather than importing a
  repository-specific one from the package. The dockable inspector pane is a
  module of the package (`@stll/ui/inspector`) rather than markup and arithmetic
  spread across route files.
