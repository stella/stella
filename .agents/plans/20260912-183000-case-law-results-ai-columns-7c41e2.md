# Plan: Case-law results with AI question columns

## Goal

The public case-law results page (`/law/cases`) becomes the one research
surface: the table gains organisation-level AI question columns whose answers
are saved per decision and computed only for the rows on the visible page,
explicit pagination, and a "save into matter" action. The separate research
table feature (`/law/cases/research/*`) is retired into it. Anonymous readers
keep the same table without AI columns.

## Current State

- Results table: `apps/web/src/routes/law/cases/index.tsx` renders
  `DecisionTable` (`features/case-law/components/decision-table.tsx`) on
  `@stll/ui/data-table` with the column model in
  `features/case-law/decision-columns.tsx`, a facet rail, toolbar (count,
  refine, sort, column chooser, research actions) and a "load more" infinite
  query (`features/case-law/queries/decisions.ts`, page size 50).
- The workspace ("matters") table is entity-bound end to end:
  `TableTreeNode = WorkspaceEntity & {…}` (`components/workspaces/table/types.ts:15`),
  `WorkspaceTable` cells call entity mutations, `BulkAddColumns` creates
  workspace `properties`. The generic layer it shares is
  `@stll/ui/data-table` (`TableSchema`, `DataTable`) and
  `components/workspaces/table/table-features.ts` (TanStack row selection,
  column visibility/ordering/pinning/sizing). Matter extraction values live in
  `fields` keyed by `entity_version_id`, so they cannot hold a decision.
- Research tables already implement "question column + per-decision answer":
  `case_law_research_tables` (organisation + owner), `_columns` (question,
  answerType, tool), `_answers` keyed `(columnId, decisionId)` with states
  `pending | answered | not_allowed | failed`, a runner
  (`lib/case-law/research-answer-runner.ts`: passages, structured output,
  role `fast`, redistribution and derived-AI gates, concurrency 3) and 13
  handlers under `handlers/case-law/research/` (auth-only, `mcp: internal`).
  The web view (`features/case-law/research/*`) renders answers with
  `DataTable` and `decisionTableSchema`. Columns are bound to a table
  (`tableId` FK), answers to a column, so an answer is invisible outside the
  table that asked the question.
- Matter links exist as API and MCP capability only:
  `case_law_matter_links` (`decisionId`, `workspaceId`, `note`, `linkedBy`,
  unique per pair), routes `/case/matter-links/:workspaceId` (list, create,
  delete), cap `LIMITS.caseLawMatterLinksPerWorkspace` = 1000. No web UI reads
  or writes them.
- Pagination: the Postgres branch is keyset only; the corpus-index branch
  carries `windowStart` but its cursor also binds `score`, `id`, `sort` and
  the expansion dictionary, and the scan proves its stop bound per window, so
  a synthesised page-N cursor is unsound. `LIMITS.caseLawSearchPageSizeMax`
  is 100.
- Gates: anonymous means no session or no active organisation
  (`hooks/use-client-auth-status.ts`); research entry points render nothing
  for anonymous readers; AI calls resolve the organisation's BYOK config via
  the auth macro; usage metering applies under `requiresUsage`. There is no
  anonymous AI path and no daily cap constant.

## Decisions

- **Question columns belong to the organisation, not to a table or a search.**
  The existing research column and answer model is the owner; columns lose
  their `tableId` and gain the organisation as their only parent. Answers stay
  keyed `(columnId, decisionId)`, which is what makes an answer reusable on
  every search that surfaces the decision. Alternative rejected: reusing
  workspace `properties` and `fields`, which are keyed by entity version and
  workspace, so a decision could not be a row without a fake entity.
- **The table shell is the generic layer, not the entity-bound one.** The
  results table adopts `@stll/ui/data-table` plus `table-features.ts`
  (selection, column visibility, ordering, pinning, sizing) and the toolbar
  controls that are pure UI (content mode). `WorkspaceTable` and
  `GroupedTableLayout` stay on entities; making them row-generic is a larger
  refactor than this slice and would drag entity mutations into a public
  page. Parity is with what a reader sees and does, not with the component
  tree.
- **Answers run per visible page only.** A run request names the column ids
  and the decision ids on the page (at most `caseLawSearchPageSizeMax`), and
  the API skips cells already answered unless forced. The estimate shown
  before a run is `rows without an answer × columns`.
- **Explicit pagination without arbitrary jumps.** Page size (25, 50, 100)
  and page number in the URL; the client keeps the cursor chain of visited
  pages, so previous, next and any visited page are direct, and unvisited
  pages are reached by walking. Alternative rejected: synthesising a corpus
  cursor from `windowStart`, which the pagination contract does not allow.
- **"Save into matter" is the first web UI on matter links.** Pin the
  selected decisions (or the page) into a chosen matter through the existing
  create endpoint; the matter shows its linked decisions with the same table
  and the organisation's columns and answers. No new view type on the matter.
- **Research tables are retired, not migrated as tables.** Their columns
  become organisation columns and their answers are kept as they are (already
  keyed by column and decision). Pinned and excluded dispositions are dropped:
  case law is not yet in production use, so no reader loses a working set.
  Old research URLs redirect to `/law/cases`.
- **Anonymous readers see no AI columns** and no run control; the sign-in
  request the page already uses is the only gate. No anonymous AI path is
  added.

## Scope

In: organisation question columns and answers, page-scoped runs, the results
table shell and toolbar parity, explicit pagination, save into matter with a
linked-decisions table in the matter, retirement of research tables with a
migration and redirects, MCP visibility unchanged (`internal`).

Out: a matter view type for case law, page-N jumps on the corpus branch,
anonymous AI, MCP or CLI exposure of question columns (the parity slice that
follows owns the agent surface), per-column model choice.

## Vertical Slices

1. **Organisation question columns and answers (API).** Migration: add
   `organization_id`-only ownership to `case_law_research_columns` (drop the
   `table_id` FK after backfilling `organization_id` from the parent table;
   unique `(id, organization_id)` stays), keep `case_law_research_answers`
   as is, add the retirement of `case_law_research_tables` and
   `case_law_research_table_decisions` to slice 4. Handlers under
   `handlers/case-law/research/` are re-scoped from table to organisation:
   list, create, update, reorder, delete columns; lookup answers by decision
   ids; run answers for `(columnIds, decisionIds)` with the page bound. Caps
   move from per table to per organisation (`LIMITS.caseLawResearchColumnsPerTable`
   becomes a per-organisation column cap; run and lookup bounds unchanged).
   The runner is untouched except for its column read. Tests: db tests for
   the re-scoped access checks (cross-organisation column ids refused), the
   skip-answered rule, and the cap.

2. **Results table shell, AI columns, page-scoped runs (web).** The table
   moves onto `table-features.ts` (selection column, column order and pin
   persistence beside the existing visibility store), keeps the rail and
   toolbar, and renders question columns with the existing answer cell and
   question dialog from `features/case-law/research/`. "Přidat sloupec"
   creates an organisation column; a run button on a column header runs the
   visible rows lacking answers after showing the estimate; answers poll as
   today. Anonymous readers get the plain table. Tests: logic files for the
   estimate, the run set (visible rows minus answered), and the column
   persistence; the research view's existing answer-cell tests move with the
   cell.

3. **Explicit pagination (web, contract unchanged).** Page size and page
   number in `validateSearch`; the query keeps the cursor chain per
   `(filters, sort, pageSize)`; a pager replaces "load more" with previous,
   next, visited pages and the page size select; the count line reads
   "Strana N" with the total. Tests: the chain logic (visited pages, reset on
   filter change), URL round trip.

4. **Save into matter and the matter's linked decisions (web + API).**
   Toolbar action on a selection: matter picker (the one the upload flow uses),
   optional note, `POST /case/matter-links/:workspaceId` per decision, toast
   with the matter name. In the matter, a "Judikatura" panel lists the linked
   decisions with the same table, columns and answers, and a remove action.
   The list endpoint gains the decision fields the table needs if missing.
   Tests: handler tests for the cap and duplicates, a logic test for the pin
   set.

5. **Retire research tables.** Delete the routes, handlers, web feature parts
   that are table-bound, the two tables, and the caps that only they used;
   redirect `/law/cases/research` and `/law/cases/research/$tableId` to
   `/law/cases`. Migration order: slice 1 first (columns re-parented), then
   this drop in a later migration once the deploy with slice 1 is out.

## Contracts and Invariants

- A question column has exactly one parent, the organisation; every column
  id in a run or lookup request must belong to the caller's organisation, or
  the request fails as a whole.
- An answer exists only for `(columnId, decisionId)`; `state = answered` iff
  `answer` is not null; a run never overwrites an answered cell unless
  `force`.
- A run request carries at most `caseLawSearchPageSizeMax` decision ids and
  at most the organisation's columns; anything larger is rejected, never
  truncated.
- Anonymous requests never reach the run or column endpoints (auth group);
  the page never renders AI controls without an active organisation.
- Matter links stay unique per `(decisionId, workspaceId)` and capped per
  workspace; pinning an already linked decision is a no-op with the existing
  link returned.
- URL state: `page` and `pageSize` are dropped when default; an invalid page
  falls back to 1; changing filters or sort resets to page 1.
- Redistribution and derived-AI gates in the runner are unchanged: a decision
  whose source forbids derived AI answers `not_allowed` for every column.

## Verification

- API: db tests for column re-parenting, cross-organisation refusal, the
  skip-answered rule, page bound, matter-link duplicates and cap; the
  security invariants suite keeps every research route in the auth group.
- Web: logic tests for the run set and estimate, the pagination chain, the
  pin set; unit tests for the migrated answer cell; web typecheck, ratchet,
  dead-export budget, result consumption, i18n sync across 13 locales.
- Manual on the real corpus: add a yes/no column, run a page of 50, page
  forward, confirm the second page runs only its own rows and the first page
  shows cached answers on return; pin three decisions into a matter and see
  them in the matter with answers.

## Rollout and Recovery

- Two migrations: re-parent columns (additive, backfill from the parent
  table inside the migration since tables are few), then drop the table
  relations after the slice-1 deploy is out. Both follow the guarded
  migration protocol.
- Old research URLs redirect; the API keeps no research-table routes after
  slice 5. Rollback before slice 5 is a redeploy; after it, the dropped
  tables are not recoverable, which is accepted because case law is not in
  production use.

## Open Questions

- Should organisation question columns be visible to every member or only
  their creator? The plan assumes every member (the organisation is the
  owner); the creator is recorded for attribution.
