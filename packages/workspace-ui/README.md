# @stll/workspace-ui

Reusable workspace presentation components and view helpers for Stella.

## Saved views

`@stll/workspace-ui/view-switcher` exports a controlled saved-view strip with
keyboard selection, horizontal overflow, inline editing slots, and bidi-aware
Pragmatic Drag and Drop reordering. Hosts retain ownership of persistence,
permissions, translations, menus, and layout rendering.

Reusable React presentation modules for Stella workspaces: field values,
property icons, sorting chips, condition builders, table loading rows, and
column calculations.

The package owns view-level rendering contracts while the surrounding workspace
supplies its data, labels, and locale. The condition builder resolves no
strings itself; labels and field options arrive through its props.

## Imports

Use the explicit subpaths for focused modules:

```tsx
import { ConditionBuilder } from "@stll/workspace-ui/conditions";
import { FieldValue } from "@stll/workspace-ui/field-value";
import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "@stll/workspace-ui/responsive-action-toolbar";
import { SortChips } from "@stll/workspace-ui/sorts";
import { WorkspaceViewSwitcher } from "@stll/workspace-ui/view-switcher";
```

The package also exposes a root entry for code that uses several workspace
surfaces together. Focused modules, including the responsive action toolbar,
are intentionally available through explicit subpaths; use those subpaths to
declare a module's
boundary.

## Feature previews

`@stll/workspace-ui/feature-previews` exports small, static product scenes for
marketing pages, menus and slides. They are composed from the components the
app renders (kanban card shell, comment cards, tracked-change marks, court
badges, matter icons, task status glyphs, money formatting), so they follow
the product as it changes.

| Component             | Shows                                              | `labels`                                                      |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| `MattersPreview`      | A matter's task board                              | `open`, `inProgress`, `done`                                  |
| `DocumentsPreview`    | A Word document with a tracked change and comments | `comments`                                                    |
| `ResearchPreview`     | Case-law search results with matched passages      | `caseLaw`                                                     |
| `BillingPreview`      | An invoice's time entries and total                | `date`, `description`, `billedTime`, `rate`, `fee`, `summary` |
| `ContactsPreview`     | A company contact filled from a business registry  | `businessRegistry`, `matters`                                 |
| `TimeTrackingPreview` | A running timer above the day's entries            | `time`, `summary`                                             |

Every scene takes the same props:

- `labels`: the interface strings it draws, typed per scene
  (`MattersPreviewLabels`, …). The package carries no catalogs.
- `locale`: the formatting locale for dates, times, durations and money
  (`en-GB`, `cs-CZ`).
- `className` (optional): classes for the outer surface.

A scene fills the box it is given (`size-full`) and clips what does not fit;
size it with the parent. It reads well from about 540 to 900 px wide at a
16:10 to 16:9 aspect. The mock content (names, documents, decisions, amounts)
is fictional and deliberately English in every locale; only `labels` are
translated. Scenes are decorative: the surface is `aria-hidden` and takes no
pointer input, so name what it illustrates beside it.

```tsx
import { MattersPreview } from "@stll/workspace-ui/feature-previews";

<div className="aspect-[16/10] w-[720px]">
  <MattersPreview
    labels={{ open: "Open", inProgress: "In progress", done: "Done" }}
    locale="en-GB"
  />
</div>;
```

Styling: the scenes use Tailwind utilities against the `@stll/ui` theme
tokens, so the host's Tailwind entry needs the theme and both packages'
shipped sources (the CSS block under Development below). Light and dark follow
the theme: put `dark` on the root element (`<html class="dark">`); the theme's
derived tokens resolve there, so a `dark` class lower in the tree leaves them
on their light values. The theme's
`--font-sans` names DM Sans; load it (for example from Google Fonts) or the
system sans serif stands in. The document page uses Tailwind's `font-serif`.

## Development

```sh
bun run build       # tsdown, one output module per source module
bun run test        # bun test src
bun run typecheck
bun run lint
```

Peer dependencies: `react`, `react-dom`, `@base-ui/react`, Pragmatic Drag and
Drop v3 with its hitbox package, TanStack React Table, and Tailwind CSS v4. The
package's components use Tailwind utility classes; the host owns the Tailwind
entry point and token configuration.

Include both published component packages in that entry point so Tailwind scans
their shipped class names:

```css
@import "tailwindcss";
@import "@stll/ui/theme.css";
@source "../node_modules/@stll/ui/dist";
@source "../node_modules/@stll/workspace-ui/dist";
```

This package is published, so public API changes need a changeset.
