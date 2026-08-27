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
`@dnd-kit/core`, and `@dnd-kit/sortable`.

## Import

Every module has its own subpath, and the package declares `sideEffects: false`,
so a bundler keeps only what is imported:

```tsx
import { Button } from "@stll/ui/button";
import { ApplicationShell } from "@stll/ui/application-shell";
import { Dialog, DialogPopup } from "@stll/ui/dialog";
import { Inspector, InspectorDock } from "@stll/ui/inspector";
import { cn } from "@stll/ui/utils";
```

One flat subpath per module: `@stll/ui/<name>` for components, hooks, and
helpers alike. `@stll/ui` re-exports all of them under one specifier for
convenience; the subpaths are the real surface, and in-repo code uses those.

## Application shell

`ApplicationShell` keeps the navigation, page chrome and content, and an
optional inline-end inspector as sibling columns. Pass the host application's
surfaces as slots; route state, navigation behavior, and inspector behavior
remain in the host.

```tsx
import { ApplicationShell } from "@stll/ui/application-shell";

<ApplicationShell
  header={<PageHeader />}
  inspector={<InspectorDock />}
  sidebar={<Navigation />}
>
  <Page />
</ApplicationShell>;
```

### Deprecated grouped subpaths

`@stll/ui/components/<name>`, `@stll/ui/hooks/<name>`, and
`@stll/ui/lib/<name>` still resolve to the same modules and are kept for one
minor. They will be removed after that; the export guard checks that both
spellings land on the same module for as long as they both exist.

## Sortable boards

`@stll/ui/kanban` provides input and accessibility primitives only; the caller
keeps item identifiers, order changes, and persisted mutations. Wrap the board
in `KanbanSortableBoard`, render sortable items through `useKanbanSortable`,
and attach the returned bindings to `KanbanDragHandle`.

```tsx
import {
  KanbanDragHandle,
  KanbanSortableBoard,
  KanbanSortableList,
  useKanbanSortable,
} from "@stll/ui/kanban";

const Card = ({ id }: { id: string }) => {
  const { dragHandle, setNodeRef } = useKanbanSortable({ id });
  return (
    <article ref={setNodeRef}>
      <KanbanDragHandle bindings={dragHandle} label="Move card" />
    </article>
  );
};

<KanbanSortableBoard onDragEnd={handleDragEnd}>
  <KanbanSortableList items={cardIds}>
    {cardIds.map((id) => (
      <Card id={id} key={id} />
    ))}
  </KanbanSortableList>
</KanbanSortableBoard>;
```

The default sensors are mouse (8px movement), touch (150ms delay with 8px
tolerance), and keyboard. Scroll containers retain `touch-action: auto`; only
`KanbanDragHandle` disables touch panning. `KanbanSortableBoard` also accepts
custom `sensors`, `accessibility`, collision detection, keyboard coordinates,
auto-scroll options, and an `overlay` render function.

`getKanbanHorizontalEdge` takes `input: "pointer"` with a current client-x and
`direction: "ltr" | "rtl"` for mouse and touch input. Keyboard calls use
`input: "keyboard"` and require source and target indices, so every move has a
logical edge without relying on ambiguous geometry.

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
