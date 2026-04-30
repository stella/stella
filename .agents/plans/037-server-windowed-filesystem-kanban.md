# Plan: Server-Windowed Filesystem and Kanban

Date: 2026-04-30

## Goal

Make filesystem and kanban scale beyond the current "render less DOM, load visible fields" model by moving their large-list data contracts to server-windowed queries. A 10k+ entity matter should not require loading every card, row field, or descendant payload just to open a view.

## Design Decisions

- **Keep the current PR focused**: The entity virtualization PR should land table windowing, visible-field trimming, and render virtualization. Filesystem and kanban server-windowing should be a follow-up PR because they need different data contracts and more interaction testing.
- **Filesystem uses hierarchy-first data**: Load lightweight folder/tree metadata separately from heavy entity fields. The view needs enough structure to build breadcrumbs, expansion state, and valid drop targets, but visible rows should be the only rows that load full card/column fields.
- **Kanban uses group-first data**: Load column summaries and counts first, then fetch each column independently. One column with thousands of cards must not force every other column to fetch or re-render its cards.
- **Mutability is explicit**: Drag between columns should only be enabled for groupings that can be written by the drop action. Built-in/read-only groupings should keep the visual affordance honest and show a toast or disabled cursor instead of allowing a silent snap-back.
- **Security remains query-scoped**: Every new endpoint must keep workspace access in the route macro and include `workspaceId` in the SQL predicates. Do not introduce fetch-then-filter behavior.

## Scope

**In scope:**

- Add filesystem-specific lightweight hierarchy/window endpoints.
- Add kanban-specific group summary and per-column window endpoints.
- Keep full entity payload loading lazy and tied to visible rows, selected rows, preview/open actions, or visible property columns.
- Preserve filtering, sorting, breadcrumbs, folder expansion, multi-select, and drag/drop behavior.
- Add focused unit tests for query shaping and grouping/tree invariants, plus Playwright smoke coverage for heavy filesystem and kanban views.

**Out of scope:**

- Calendar and timeline server-windowing.
- Full workspace cap removal.
- New database tables unless query performance proves existing indexes are insufficient.
- Reworking document preview or file storage.
- Reintroducing global-header bulk actions.

## Implementation

- `apps/api/src/handlers/entities/` — add handlers for tree summaries, folder child windows, kanban group summaries, and kanban group windows. Reuse `query-entities.ts` where the shape matches; split helpers when tree/group queries need narrower selects.
- `apps/api/src/lib/entity-filters.ts` — ensure filter/sort helpers can produce stable SQL for hierarchy and group-window queries without returning unbounded result sets.
- `apps/api/src/db/schema.ts` — add or verify indexes for workspace-scoped parent traversal, kind filtering, sort order, status/priority/due-date, and JSONB property grouping where needed.
- `apps/web/src/routes/_protected.workspaces/$workspaceId/-queries/entities.ts` — add typed query option factories for filesystem hierarchy/windows and kanban group/windows. Keep keys explicit and separate from the legacy page query.
- `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view.tsx` — replace whole-workspace entity loading with hierarchy/window data. Keep the flat virtualized row list, but source visible row payloads from visible windows or lazy row-detail queries.
- `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.tsx` — replace whole-board grouping with group summary queries plus per-column infinite queries.
- `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-column.tsx` — keep TanStack virtual per column, but trigger per-column `fetchNextPage` near the end of the virtual range.
- `apps/web/src/routes/_protected.workspaces/$workspaceId/$viewId.route.tsx` — preload only the initial hierarchy/group summary and first visible windows for the active view.

## Test Cases

- Filesystem hierarchy endpoint returns only entities from the requested workspace.
- Filesystem child window preserves stable sort order and returns `nextCursor` correctly.
- Filtering in filesystem returns matching entities plus enough ancestor metadata to render context.
- Collapsed/off-screen folders remain valid move targets through the server-known folder index or an explicit move-target query.
- Kanban group summary returns stable group labels/counts for status, kind, author, and single-select property groupings.
- Kanban per-column windows do not fetch cards for unrelated columns.
- Dragging in writable single-select/status groupings mutates the right field/status and invalidates only affected windows.
- Dragging in read-only groupings is visibly disabled or shows an explanatory toast.
- Heavy seed Playwright smoke: filesystem opens, scrolls, expands/collapses, and opens preview; kanban opens, scrolls a 1k+ card column, and changes a writable grouping.

## Open Questions

- Should filesystem load the full folder index up front, or should it page children per expanded folder from the start?
- For filesystem search/filter, should the endpoint return matched rows plus ancestors, or a separate "search results" flat mode?
- For kanban property grouping over JSONB fields, do we need generated/indexed columns for common property values before lifting the workspace cap?
- How much optimistic cache patching should the follow-up PR do versus invalidating narrow window/group queries after mutations?
