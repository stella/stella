# Plan: Case-law results through the workspace table

## Goal

The case-law results page renders through the workspace ("matter") table and
its property model, with decisions as rows. Column drag-and-drop, the
properties menu, every value kind, the justification hover card and the
inspector open action are the same components a matter uses; nothing on the
results page reimplements them. Anything in the table that does not translate
to a non-entity row is generalised in its owner, never copied.

## Current State

- `TableTreeNode = WorkspaceEntity & { children }` and every TanStack alias is
  bound to it (`components/workspaces/table/types.ts:15-35`).
  `workspaceTableFeatures` (`table-features.ts`) is already entity-free and the
  interim `DecisionTable` uses it, but renders through `@stll/ui/data-table`
  with its own column set (`features/case-law/decision-columns.tsx`), its own
  layout store and its own answer cell.
- `WorkspaceTable` (`-components/table/workspace-table/index.tsx`) binds to
  entities in six places: rename (`useRenameEntity`), folder descendants,
  inspector tab lookup, select-all store key, row-drag payload, and the
  add-column and bottom-row controls. Column DnD, ordering, pinning, sizing and
  header menus carry no entity data.
- `WorkspaceColumnRender` (`-components/table/table-schema.ts:31-48`) is a
  closed union dispatched in one exhaustive switch
  (`table-columns.tsx:144-256`); property columns read `row.fields[id]`.
- `WorkspaceTableAdapter` (`lib/workspaces/table-adapter.ts:27-43`) is four
  `typeof` aliases of the entity hooks, not a structural interface.
- Properties, fields, cell metadata and justifications are workspace-scoped
  with a field keyed by `entityVersionId`; question columns and answers are
  organisation-scoped with an answer keyed by `(columnId, decisionId)`. The
  value-type registry (`lib/value-types.ts`, `@stll/workspace-ui` field-value)
  is entity-free; the answer cell knows two kinds.
- Justification card (`components/workspaces/justification.tsx`) renders
  citation-shaped content; only `PdfChip`'s three store writes are bound to a
  document file. The decision answer carries `passages[{anchorId, excerpt}]`
  and a route navigation, not an inspector tab.
- Runners: workspace extraction (BullMQ, `extraction_runs`, cell locks, fields
  plus justifications in one transaction, source = sibling fields) versus the
  research answer runner (detached workers, passages from the AST, licence
  gates, `run.passages`). Output shapes differ.

## Decisions

- **Rows are a discriminated union, not a second table.** `TableRowData =
  { kind: "entity"; … } | { kind: "decision"; … }`; the TanStack aliases take
  the row type, `WorkspaceTable` receives a `RowHost` object supplying the six
  entity behaviours (rename, descendants, open, select-all key, drag payload,
  extra controls), the entity host implements them, the decision host
  implements what applies and declines the rest by type. Alternative rejected:
  a decision-shaped `TableTreeNode` substitute, which forks the shell.
- **One column union.** `WorkspaceColumnRender` gains a `decision` member for
  the decision columns; the interim schema in `decision-columns.tsx` becomes
  that member's renderers and its own schema is deleted. Column
  hidden/order/pin persistence is injected as a layout object, supplied by the
  view layout for matters and by the per-country store for the results page.
- **Property model converges at the content and citation shapes, not the
  tables.** Question columns adopt the property content types (every value
  kind the registry knows); answers are stored as `FieldContent`; a run's
  passages are stored as the justification citation shape. Tables stay
  separate because fields hang off entity versions under workspace isolation
  and answers hang off decisions under organisation scope; forcing one table
  would relax a tenant boundary to save a join. One cell renderer serves both.
- **Justification source is a union.** `{ kind: "field"; … } | { kind:
  "decision"; decisionId; anchorId; excerpt }` on the card, with the host's
  `onOpenSource`; the decision branch opens the public-law inspector at the
  anchor with the reader's highlight. `PdfChip` stays the field branch.
- **Add-column dialog has one body and two targets.** `BulkAddColumns`' draft
  form is the dialog; its target is `{ kind: "workspace"; workspaceId } |
  { kind: "organisation" }` deciding which mutation and which extra controls
  (document-type gate, prompt suggestion) apply. The research question dialog
  is deleted.
- **Runner convergence is by output contract, not by queue.** The research
  runner produces the same `FieldContent` per value kind and the same
  citation shape as the workspace extractor, through one shared output schema
  module; the queues stay separate because their tenancy and durability
  differ. A later slice may move the research runner onto `extraction_runs`
  once decisions have a workspace context (pinned into a matter).

## Scope

In: generic row model and host seam, decision column member, injected column
layout, justification source union, add-column target union, question columns
over every value kind with `FieldContent` answers and citation-shaped
passages, results page rendered through `WorkspaceTable`, deletion of the
interim table, column schema, answer cell and question dialog. Out: moving the
shell to `@stll/workspace-ui` (a later publish once two hosts exist), a shared
queue, grouped/kanban layouts for decisions, the research-table retirement
(its own follow-up).

## Vertical Slices

1. **Row union and host seam (web).** `types.ts` aliases generic over
   `TableRowData`; `RowHost` on `WorkspaceTableProps`; the entity host moves
   the six behaviours out of `index.tsx`/`row-cells.tsx` into
   `-components/table/entity-row-host.ts`; `WorkspaceTableAdapter` becomes a
   structural interface. Matters render identically. Tests: the existing table
   suites stay green; a type-level test that a decision row cannot reach an
   entity behaviour.
2. **Decision column member and injected layout (web).** `decision` member in
   `WorkspaceColumnRender`, renderers moved from `decision-columns.tsx`,
   switch extended; `hidden/order/pinned` injected; `PropertiesToggle` reads
   the injected column list. Tests: `table-schema.test.ts` gains decision
   fixtures.
3. **Question columns over every value kind (API + contract + web).** Column
   `answerType` becomes the property content type; answer stored as
   `FieldContent`; `run.passages` stored as citations; the research runner's
   output schema comes from the shared module keyed by value kind; the answer
   cell is `FieldValue` from `@stll/workspace-ui` with the justification card.
   Migration: widen `case_law_research_answers.answer` by content shape (jsonb,
   validated), drop `confidence`. Tests: per-kind output round trips, gate
   tests unchanged.
4. **Results page on `WorkspaceTable` (web).** Decision host, decision
   adapter (`useListPage` from the paged decisions query), justification
   source union with the inspector open action, `BulkAddColumns` with the
   organisation target, deletion of `DecisionTable`, the interim column schema,
   `research-answer-cell.tsx` and `research-question-dialog.tsx`. Matter panel
   uses the same. Tests: the results route logic suites; a render-count guard
   on the controlled-state identity (the loop that bit once).

## Contracts and Invariants

- A row's kind decides which host behaviours exist; the type system forbids
  calling an entity behaviour on a decision row.
- Column ids are unique across built-in, decision and property columns; the
  schema tests assert it.
- An answer's content validates against the column's value kind on write; a
  kind change invalidates answers (already the rule) and the migration keeps
  it.
- The justification source union is exhaustive at every switch.
- Tenant boundaries are unchanged: fields under workspace policies, answers
  under organisation policies.

## Verification

Existing table, schema, store and case-law logic suites; new type-level and
per-kind tests; web and API typecheck; ratchets, dead-export budget,
projection totality, result consumption; the route-smoke network baseline
(no new request on matter routes). Manual: matters table unchanged; results
page with drag-and-drop columns, a number and a date question column, a hover
showing the cited passage, open in inspector highlighting it.

## Rollout and Recovery

Stacked on #3279; lands after it. One additive migration (answer shape,
confidence drop) under the guarded protocol; rollback is a redeploy before the
research-table retirement.

## Open Questions

None; the owner's direction is to generalise the shared primitives rather
than keep a parallel implementation.
