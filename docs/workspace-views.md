# Workspace views

A workspace view renders the same rows three ways — a table, a board, a
filesystem tree — over a layout the view stores on the server. This page
documents the two contracts the board and the table share, and where each half
of them lives.

## Where the code lives

| Concern                                    | Module                                                | Knows about entities? |
| ------------------------------------------ | ----------------------------------------------------- | --------------------- |
| Board grouping, card chrome, column header | `@stll/ui/kanban`                                     | No                    |
| Option colour tokens                       | `@stll/ui/option-color`                               | No                    |
| Column calculations (the reducer)          | `@stll/calculations`                                  | No                    |
| Calculation formatting and controls        | `@stll/workspace-ui/calculations`                     | No                    |
| The workspace's instance of all of it      | `apps/web/src/routes/_protected.workspaces/…/kanban/` | Yes                   |

The rule the split enforces: nothing under `packages/ui` imports an API contract
or an entity type. A lint rule in `oxlint.config.ts` keeps `@stll/ui` free of
workspace imports entirely; its tests may import `@stll/property-testing` and
nothing else.

## Grouping: `KanbanSchema`

A board's columns come from one of two places, and the schema says which:

- **A property.** `getPropertyOptions(property)` returns the property's options
  as columns, or `null` when the property cannot carry columns at all. The
  workspace returns options for single- and multi-select properties.
- **A built-in group.** A reserved id (`_status`, `_kind`, `_created-by`), a
  fixed column list, and an optional `selectRows` that narrows the board to the
  rows the grouping can place. The status board is a board of tasks because its
  built-in group says so, not because the grouping code knows what a task is.

A built-in group that declares no columns cannot be drawn:
`isKanbanGroupingRenderable` reads exactly that, and the board falls back to the
"pick a property" prompt. `_created-by` is the case — its authors are whoever
happens to be in the workspace, not a fixed set.

The uncategorized bucket is always appended last, exactly once, by
`getKanbanGroups`.

The grouped table reads its sections through the same schema, so the two views
never disagree about what a group is called.

## Cards

`selectKanbanCardFieldIds` decides which properties a card renders as values.
The caller names the fields the card draws itself (the badge row, the footer)
as `reservedFieldIds`, and vetoes the rest through `isRenderable`. The card
component holds no list of internal ids.

`KanbanCardShell` is the card's chrome: border, hover lift, active ring, drag
wrapper. A card that opens something passes `onOpen` and gets the button role
and the keyboard contract; a card that opens nothing gets neither, so it never
lands in the tab order.

## The table: a column schema

Which columns a table view has, in what order, and what each may do is a
`TableSchema`: a list of descriptors, each with an id, a label, a starting
width, its capabilities (`sort`, `hide`, `resize`, `pin`), and an `emphasis`.

The kit never looks inside a descriptor's `render`, which is why the workspace
can keep an exhaustively checked union there — one arm per kind of column, from
the selection checkbox to a property column carrying its property and the
verdict column paired with it. `table-columns.tsx` turns each descriptor into
the definition the table library wants; nothing else decides what the columns
are.

Two rules are the schema's, not the renderer's:

- **A column that cannot be hidden stays visible**, whatever the stored hidden
  list says. A column that lost its hide capability while it was hidden cannot
  strand a table without its select column.
- **A duplicate column id silently drops a column** — the table keys by id, so
  the second declaration wins and the first vanishes with no error anywhere.
  `duplicateColumnIds` is how a schema built from user data checks.

## Where rows come from

The table stack reads rows through four named entry points, in
`apps/web/src/lib/workspaces/table-adapter.ts`: a flat window, a section window,
the per-section counts that let an empty section skip its row query, and one row
for a detail surface. Each is a query-options factory, so the table never
fetches and the transport stays with the data layer. A contract test totals over
the adapter's keys, so a fifth row source cannot land unnamed.

## Column calculations

A view can say what each column adds up to. The choice lives on the view layout
next to `hiddenProperties` and `sorts`:

```jsonc
"calculations": [{ "propertyId": "fee", "kind": "sum" }]
```

It is optional. A view that has never chosen one stores nothing and shows
nothing.

`@stll/calculations` is the reducer. It takes a `CalculationValue` per row —
`empty`, `number`, `money`, or `text` — and returns one of:

| Kind                                                   | Result                               |
| ------------------------------------------------------ | ------------------------------------ |
| `count`, `count-unique`, `count-empty`, `count-filled` | a row count                          |
| `percent-empty`, `percent-filled`, `percent-of-total`  | a share between 0 and 1              |
| `sum`, `average`, `median`, `min`, `max`, `range`      | a number, or one amount per currency |

Two rules are structural rather than conventional:

- **Money never crosses currencies.** A monetary reduction buckets through
  `MoneyTotals` and returns one line per currency. The header shows them
  separated; the tooltip lists them.
- **A reduction with no answer says so.** Text under a sum, numbers mixed with
  money, and an average over no values are explicit `unsupported` results, not
  zeros.

The board's column header and the table's totals row run the same reducer over
the same values, which is what makes them agree. Grouped table sections each
total their own rows.

Opting in per column is what makes a total meaningful: the earlier attempt
summed every numeric column automatically, which is wrong for a column of days,
and had been switched off by hard-coding its property list to the empty array.

Mapping a workspace field onto a `CalculationValue` happens in one place,
`apps/web/src/lib/workspaces/calculations.ts`. A `money` field reduces as money;
an `int` carrying a currency reduces as a plain number, because an int's value
is major units and money's is minor units — which is exactly why they are two
property types and not one.

## Property types

`money` and `person` are display, filter, sort and calculation types. Neither
has an inline editor and neither is offered by the property composer, so a
workspace holds one only if the API put it there. Neither is AI-extractable
either: an amount needs a currency a model cannot choose and a person has to
resolve to a workspace member. That exclusion is one predicate,
`isAiExtractablePropertyContent`, and the batch property's content type is bound
to it, so the prompt builder, the answer validator and the mock are exhaustive
by construction.
