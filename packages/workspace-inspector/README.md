# @stll/workspace-inspector

React primitives for a **dockable, resizable inspector pane** — the side
panel pattern Stella's workspace uses for matter, document, and entity
detail.

The package ships the parts that are genuinely reusable: the width
arithmetic, the dock (spacer + fixed overlay + drag handle), and the chrome
(rail, header, fixed-height key/value rows). It deliberately ships no data
fetching, no tabs library, and no store — the host app supplies those.

```sh
bun add @stll/workspace-inspector
```

Peer dependency: `react >= 19`. Styling is Tailwind CSS v4 utility classes
against the host's theme tokens (see [Theme tokens](#theme-tokens)).

## Why a spacer behind a fixed pane

The pane is `position: fixed` so it spans the full viewport height without
the topbar having to leave room for inspector chrome. A fixed element is out
of flow, so on its own it would _cover_ the content column. `InspectorDock`
renders a same-width in-flow spacer beside it, and the content column
reflows against that instead.

Because nothing in the layout pushes back when the pane grows, whatever the
pane takes comes straight out of the content column. `resolveInspectorPaneWidth`
is therefore not optional: without the clamp, shrinking the window or
expanding the sidebar leaves the content column a few dozen pixels wide
instead of folding.

## Usage

```tsx
import {
  Inspector,
  InspectorContent,
  InspectorDock,
  InspectorHeader,
  InspectorProperty,
  InspectorPropertyLabel,
  InspectorPropertyList,
  InspectorPropertyValue,
  InspectorRail,
  InspectorTitle,
  resolveInspectorDockWidth,
  useInspectorPaneWidth,
} from "@stll/workspace-inspector";

const OrderInspector = ({ open, sidebarWidth, viewportWidth }) => {
  const { resetWidth, resizeHandleProps, width } = useInspectorPaneWidth({
    sidebarWidth,
    storageKey: "inspector:pane-width",
    viewportWidth,
  });

  return (
    <InspectorDock
      resizeHandleLabel="Resize panel"
      resizeHandleProps={resizeHandleProps}
      showPaneContent={open}
      width={resolveInspectorDockWidth({
        paneWidth: width,
        showPaneContent: open,
      })}
      onResetWidth={resetWidth}
    >
      <Inspector>
        <InspectorRail>{/* icon tabs */}</InspectorRail>
        <div className="flex min-w-0 flex-1 flex-col">
          <InspectorHeader>
            <InspectorTitle>ZL-2026-0042</InspectorTitle>
          </InspectorHeader>
          <InspectorContent>
            <InspectorPropertyList>
              <InspectorProperty>
                <InspectorPropertyLabel>Status</InspectorPropertyLabel>
                <InspectorPropertyValue>In progress</InspectorPropertyValue>
              </InspectorProperty>
            </InspectorPropertyList>
          </InspectorContent>
        </div>
      </Inspector>
    </InspectorDock>
  );
};
```

`InspectorDock` is desktop-only (`hidden md:block`). Below the `md`
breakpoint, render the same `<Inspector>` subtree inside your own
full-screen sheet — the chrome does not care which container it sits in.

## Fixed row height, on purpose

`InspectorProperty`, `InspectorSectionTitle`, `InspectorHeader`,
`InspectorEmptyRow`, and every rail cell are exactly `h-12` (48px) — a fixed
height, not a minimum.

A row that grows to fit its value breaks the rhythm the rail's cells set,
and a column of rows at differing heights stops reading as a scannable list,
which is the whole point of the layout. Long values truncate; the full text
belongs in a tooltip or an expanded view, not in a taller row. A class
contract test enforces this, so the constraint cannot be relaxed by
accident.

## Width policy

| Constant                       | Value | Meaning                                         |
| ------------------------------ | ----- | ----------------------------------------------- |
| `INSPECTOR_PANE_DEFAULT_WIDTH` | 512   | Width a fresh pane opens at                     |
| `INSPECTOR_PANE_MIN_WIDTH`     | 320   | Below this the pane stops being readable        |
| `INSPECTOR_PANE_MAX_WIDTH`     | 800   | Beyond this the pane is a second content column |
| `INSPECTOR_CONTENT_MIN_WIDTH`  | 400   | Floor for the column _beside_ the pane          |
| `INSPECTOR_RAIL_WIDTH`         | 48    | Footprint while the pane is collapsed           |

`useInspectorPaneWidth` keeps the width the user dragged to and returns that
value clamped against the room actually available, so the pane returns to
the user's choice once the room comes back. Pass `storageKey` to remember it
across reloads; omit it to keep the width in memory only.

`shouldForceSidebarCollapsed` implements the yielding policy: the expanded
sidebar gives up its optional width before either docked pane may violate
its minimum.

## Theme tokens

The chrome renders against these host-defined CSS variables (Tailwind v4
`@theme` names): `--color-background`, `--color-foreground`,
`--color-muted-foreground`, `--color-accent`, `--color-border`,
`--color-primary`, `--color-sidebar`, `--color-sidebar-foreground`. Any
Tailwind v4 theme that defines them will render the inspector correctly.

## License

Apache-2.0
