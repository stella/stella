# @stll/ui

Stella's design system: the React primitives the product surfaces are built
from, the dockable inspector pane, and the Tailwind v4 theme they are styled
with.

The package is self-contained by construction. It imports no application
module, no path alias, and no other workspace package, so every component can
be rendered and tested without a surrounding application — and a change to one
cannot reach into product code by accident. Lint enforces that boundary; the
export map below is what "part of the design system" means.

Peer dependencies: `react`, `react-dom`, `@base-ui/react`, `tailwindcss` (v4),
and `@tanstack/react-virtual`.

## Import

Every module has its own subpath, and the package declares `sideEffects: false`,
so a bundler keeps only what is imported:

```tsx
import { Button } from "@stll/ui/button";
import { Dialog, DialogPopup } from "@stll/ui/dialog";
import { Inspector, InspectorDock } from "@stll/ui/inspector";
import { cn } from "@stll/ui/utils";
import { WorkspaceShell } from "@stll/ui/workspace-shell";
```

One flat subpath per module: `@stll/ui/<name>` for components, hooks, and
helpers alike. `@stll/ui` re-exports all of them under one specifier for
convenience; the subpaths are the real surface, and in-repo code uses those.

## Workspace shell

`WorkspaceShell` is the complete desktop and tablet application frame. It
keeps navigation, sticky top chrome, the active route, and an optional
inline-end dock as sibling surfaces inside one dynamic viewport. A host with
nothing for the inline-end edge omits `endDock`, and the content column
extends to the frame's edge instead of reserving width for an empty rail. Route content
is the sole scroller, so a feature cannot accidentally render an app inside
the app.

```tsx
import { WorkspaceEndRail, WorkspaceShell } from "@stll/ui/workspace-shell";

<WorkspaceShell
  endDock={
    <WorkspaceEndRail
      chatAction={{
        label: "New chat",
        onActivate: openChat,
        status: "enabled",
      }}
      label="Workspace inspector"
      topAction={<InspectorToggle />}
    />
  }
  navigation={{ content: <Navigation />, mode: "responsive" }}
  topBar={() => <WorkspaceHeader />}
>
  <Workspace />
</WorkspaceShell>;
```

Applications without their own responsive navigation use the shell-managed
contract. Stella then owns the desktop/compact cutoff, sheet portal, backdrop,
Escape and viewport-close behavior; the top-bar callback places the supplied
trigger in product-specific chrome.

```tsx
<WorkspaceShell
  endDock={<WorkspaceInspector />}
  navigation={{
    compact: {
      content: <Navigation expanded />,
      label: "Open navigation",
      onOpenChange: setNavigationOpen,
      open: navigationOpen,
      trigger: <button type="button">Menu</button>,
    },
    desktop: <NavigationRail />,
    mode: "shell-managed",
  }}
  topBar={({ compactNavigationTrigger }) => (
    <WorkspaceHeader navigationTrigger={compactNavigationTrigger} />
  )}
>
  <Workspace />
</WorkspaceShell>
```

`WorkspaceEndRail` owns the 48px rail, 44px touch targets, scrolling tab
region, and permanent bottom chat position. Its chat action is a discriminated
union: a host must wire an enabled action or expose a reasoned, fail-closed
unavailable state.

### Deprecated grouped subpaths

`@stll/ui/components/<name>`, `@stll/ui/hooks/<name>`, and
`@stll/ui/lib/<name>` still resolve to the same modules and are kept for one
minor. They will be removed after that; the export guard checks that both
spellings land on the same module for as long as they both exist.

## Kanban boards

`@stll/ui/kanban` provides board matrices, subgroup swimlanes, bounded virtual
cells, and column bands. The caller owns card rendering, permissions, and
persisted mutations.

For Group/Sub-group boards, build one canonical matrix and render it with the
installable layout and virtual cell:

```tsx
import {
  KanbanSubgroupBoard,
  KanbanVirtualCell,
  buildKanbanBoardMatrix,
} from "@stll/ui/kanban";

const matrix = buildKanbanBoardMatrix({
  group,
  subgroup,
  rows,
  resolveGroupValue,
  uncategorizedLabel: "No value",
});

<KanbanSubgroupBoard
  matrix={matrix}
  renderColumnHeader={({ column, count }) => (
    <ColumnHeader column={column} count={count} />
  )}
  renderLaneIdentity={({ group: lane }) => <Lane group={lane} />}
  renderCell={({ cell }) => (
    <KanbanVirtualCell
      getRowKey={(row) => row.id}
      pagination={{ type: "none" }}
      renderRow={(row) => <Card row={row} />}
      rows={cell.rows}
    />
  )}
/>;
```

### Column bands

Columns whose options carry a `band` (`KanbanColumnBand`, usually a status
property's option groups) render under one `KanbanColumnBandHeader` and fold
as a run. `resolveKanbanColumnBands` derives the bands from the column order
and rejects a band that resumes after another column, so a header can never
span two separate runs. A folded band takes one narrow slot in every row;
render a drop target in `renderCollapsedBandCell` to keep its hidden cells
reachable, and the slot peeks open while a pointer rests on it. Pass
`isBandCollapsed` and `onBandCollapsedChange` to persist the fold in a view.

```tsx
<KanbanSubgroupBoard
  isBandCollapsed={(band) => collapsedBands.includes(band.id)}
  matrix={matrix}
  renderCell={renderCell}
  renderCollapsedBandCell={({ band, cells, count }) => (
    <FoldedDropTarget bandId={band.id} cells={cells} count={count} />
  )}
  renderColumnHeader={renderColumnHeader}
  renderLaneIdentity={renderLaneIdentity}
  onBandCollapsedChange={(band, collapsed) => saveFold(band.id, collapsed)}
/>
```

### Lane controls that survive a scroll

The board measures its sticky header block and publishes its height on the
scroll container as `KANBAN_STICKY_TOP_VAR` (`--kanban-sticky-top`), so a
lane's controls can rest just under the header and release where the lane
ends. `KanbanVirtualCell` takes `footerPlacement="sticky-start"` to pin its
`footer` above the rows instead of closing the cell with it, and
`KanbanCollapsedBandCaption` keeps a folded band's name and count in view down
a tall lane. A cell that keeps its own bounded scroll surface is its own
scroll container, where the board's header offset means nothing; reset the
variable on it so the action rests at the cell's own top.

```tsx
<KanbanVirtualCell
  className="[--kanban-sticky-top:0px]"
  footer={<KanbanCellAction onClick={addCard}>New card</KanbanCellAction>}
  footerPlacement="sticky-start"
  getRowKey={(row) => row.id}
  pagination={{ type: "none" }}
  renderRow={(row) => <Card row={row} />}
  rows={cell.rows}
/>
```

A host rendering its own collapsed band cell fills the slot and composes the
caption inside it:

```tsx
renderCollapsedBandCell={({ band, cells, count }) => (
  <FoldedDropTarget bandId={band.id} cells={cells}>
    <KanbanCollapsedBandCaption label={band.label} meta={count} />
  </FoldedDropTarget>
)}
```

## Grouped lists and search

`@stll/ui/list` renders inventories of named things (connections, sessions,
keys) as titled groups of hairline-divided rows. Rows truncate their content
column and keep their trailing column, so they never scroll sideways.

```tsx
<ListGroup aria-labelledby="apps">
  <ListGroupHeader>
    <ListGroupHeading>
      <ListGroupTitle id="apps">
        Apps with access<ListGroupCount>3</ListGroupCount>
      </ListGroupTitle>
      <ListGroupDescription>Apps you authorized.</ListGroupDescription>
    </ListGroupHeading>
  </ListGroupHeader>
  <List>
    <ListItem>
      <ListItemMedia>C</ListItemMedia>
      <ListItemContent>
        <ListItemTitle>Claude</ListItemTitle>
        <ListItemDescription>Connected 3 days ago</ListItemDescription>
      </ListItemContent>
      <ListItemActions>
        <ListItemStatus tone="success">Connected</ListItemStatus>
      </ListItemActions>
    </ListItem>
  </List>
</ListGroup>
```

Pass `render={<a href="…" />}` to `ListItem` to make the whole row a link.
`@stll/ui/search-field` is the matching filter box: leading magnifier, clear
button, and Escape clears the query. The caller owns the query and the
matching.

## Styles

No compiled CSS ships. The components carry Tailwind class names, so the
Tailwind build stays with the application that uses them:

```css
@import "tailwindcss";
@import "@stll/ui/theme.css";
@source "../node_modules/@stll/ui/dist";
```

`theme.css` carries the `@theme` token map, the palettes, the base layer, and
the custom utilities. The `@source` line is what makes Tailwind scan the
shipped components for the utilities they use — node_modules is outside its
default source detection.

`theme.css` is the only stylesheet the package exports. Each application owns
its own Tailwind entry (`apps/web/src/styles/app.css`,
`apps/desktop/src/mainview/index.css`, `apps/playground/src/styles.css`), which
is where the source globs for that application belong.

## Layout direction

The components are bidirectional. Use logical properties (`ms-*`, `pe-*`,
`start-*`) rather than physical ones, and let the slots that render
caller-supplied values (names, identifiers, filenames) keep their `dir="auto"`
and bidi isolation.

## Development

```sh
bun run build       # tsdown, one output module per source module, with .d.ts
bun run test        # unit tests
bun run test:unit   # unit tests only
bun run test:browser # Chromium mobile-input tests
bun run typecheck
bun run lint
```

`bun scripts/check-published-exports.ts packages/ui` (from the repository root)
runs the publish path end to end: build, `prepare-publish`, `bun pm pack`, then
resolves and imports every declared subpath from the built `dist`.

`bun run pack:check` runs that published-package check for this package.

This package is published, so a change here needs a changeset:

```sh
bun changeset            # anything a consumer of the package can observe
bun changeset --empty    # internal refactor, no change to the public surface
```
