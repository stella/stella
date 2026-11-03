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

## Formatting locale

Field values and column calculations format numbers, money and dates in the
reader's formatting locale, which can differ from the UI language that
`use-intl`'s `IntlProvider` serves messages in (an English interface with
German number formatting, say). Render them inside
`WorkspaceUiFormattingProvider`; without it they throw rather than fall back
to the UI language.

```tsx
import { WorkspaceUiFormattingProvider } from "@stll/workspace-ui/formatting";

<IntlProvider locale="en" messages={messages} timeZone="Europe/Prague">
  <WorkspaceUiFormattingProvider locale="de-DE" timeZone="Europe/Prague">
    {children}
  </WorkspaceUiFormattingProvider>
</IntlProvider>;
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

| Component             | Shows                                              | `labels`                                                      | `data`                    |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------- | ------------------------- |
| `MattersPreview`      | A matter's task board                              | `open`, `inProgress`, `done`                                  | `MattersPreviewData`      |
| `DocumentsPreview`    | A Word document with a tracked change and comments | `comments`                                                    | `DocumentsPreviewData`    |
| `ResearchPreview`     | Case-law search results with matched passages      | `caseLaw`                                                     | `ResearchPreviewData`     |
| `BillingPreview`      | An invoice's time entries and total                | `date`, `description`, `billedTime`, `rate`, `fee`, `summary` | `BillingPreviewData`      |
| `ContactsPreview`     | A company contact filled from a business registry  | `businessRegistry`, `matters`                                 | `ContactsPreviewData`     |
| `TimeTrackingPreview` | A running timer above the day's entries            | `time`, `summary`                                             | `TimeTrackingPreviewData` |

Every scene takes the same props:

- `labels`: the interface strings it draws, typed per scene
  (`MattersPreviewLabels`, …). The package carries no catalogs.
- `locale`: the formatting locale for dates, times, durations and money
  (`en-GB`, `cs-CZ`).
- `data` (optional): what the scene depicts, typed per scene
  (`MattersPreviewData`, …). Without it the scene shows the package's one
  fictional English set; supply your own for another jurisdiction, language
  or audience.
- `className` (optional): classes for the outer surface.

A scene fills the box it is given (`size-full`) and clips what does not fit;
size it with the parent. It reads well from about 540 to 900 px wide at a
16:10 to 16:9 aspect; keep custom content about as long as the default so it
fits as well. Scenes are decorative: the surface is `aria-hidden` and takes
no pointer input, so name what it illustrates beside it.

```tsx
import { MattersPreview } from "@stll/workspace-ui/feature-previews";

<div className="aspect-[16/10] w-[720px]">
  <MattersPreview
    labels={{ open: "Open", inProgress: "In progress", done: "Done" }}
    locale="en-GB"
  />
</div>;
```

### Custom content

`data` is plain data: the scene formats it with `locale` and computes what it
can (column counts, invoice amounts and totals, the day's total time). Dates
are `YYYY-MM-DD`, times `HH:MM`, durations whole minutes; text is drawn as
given. Two shapes are shared:

- `PreviewPerson`: `{ name }`, drawn as initials.
- `PreviewMatter`: `{ id, color, name }`; `color` is a matter colour token
  (`--option-blue`, `--option-violet`, …).

Per scene:

- `MattersPreviewData`: `{ matter, team, tasks }`. Each `MattersPreviewTask`
  has `name`, `status` (`MattersPreviewTaskStatus`: `open`, `in_progress`,
  `done`), `due`, `assignee` and `attachment` (a file name or `null`).
- `DocumentsPreviewData`: `fileName`, `reviewers`, `title`, `heading`,
  `trackedChange` (`before`, `deleted`, `inserted`, `after`), `commented`
  (`before`, `marked`, `after`), `nextHeading`, `clauses` and `comments`.
  Each `DocumentsPreviewComment` has `author`, `time`, `anchor` (the quoted
  passage) and `body`.
- `ResearchPreviewData`: `{ query, decisions }`. Each
  `ResearchPreviewDecision` has `court` (`name`, `abbreviation`, and `tier`:
  `constitutional`, `supreme`, `regional` or `other`), `date`, `fileNumber`
  and the matched passage as `before`, `hit`, `after`.
- `BillingPreviewData`: `invoiceNumber`, `client`, `matter`, `currency` (ISO
  4217), `hourlyRate` (minor units, minted with `cents` from `@stll/money`)
  and `entries`. Each `BillingPreviewEntry` has `date`, `description` and
  `billedMinutes`.
- `ContactsPreviewData`: `company` (`name`, `legalForm`, `status`,
  `registry`, `details` as `{ label, value }` pairs, `incorporatedOn` as
  `{ label, date }`) and `linkedMatters`. Registry field titles are the
  registry's own, as the app shows them, so they travel with the data rather
  than `labels`.
- `TimeTrackingPreviewData`: `day`, `running` (`description`, `matter`,
  `elapsedMinutes`) and `entries`. Each `TimeTrackingPreviewEntry` has
  `start`, `end`, `minutes`, `description` and `matter`.

Declare content with `satisfies`, so a missing or misspelt field fails
typecheck:

```tsx
import { cents } from "@stll/money";
import { BillingPreview } from "@stll/workspace-ui/feature-previews";
import type { BillingPreviewData } from "@stll/workspace-ui/feature-previews";

const invoice = {
  invoiceNumber: "INV-0042",
  client: "Northwind Shipping Ltd",
  matter: {
    id: "northwind",
    color: "--option-blue",
    name: "Northwind charter dispute",
  },
  currency: "GBP",
  hourlyRate: cents(30_000),
  entries: [
    {
      date: "2026-10-05",
      description: "Review of the charterparty",
      billedMinutes: 120,
    },
    {
      date: "2026-10-07",
      description: "Draft letter to owners",
      billedMinutes: 90,
    },
  ],
} as const satisfies BillingPreviewData;

<BillingPreview
  data={invoice}
  labels={{
    date: "Date",
    description: "Description",
    billedTime: "Hours",
    rate: "Rate",
    fee: "Amount",
    summary: "Total",
  }}
  locale="en-GB"
/>;
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
