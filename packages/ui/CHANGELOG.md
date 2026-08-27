# @stll/ui

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
