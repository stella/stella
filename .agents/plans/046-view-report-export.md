# Plan: View report export (DD report DOCX)

Date: 2026-07-02

## Goal

Export a workspace table view (extracted columns, with or without playbook
verdicts) into a .docx report using the existing template semantics. The
first shipped report is the standard due-diligence format: executive
summary, then contract-by-contract sections, each with a field/value table
and a risks block. The report layout is an ordinary org template, so firms
can adapt it to house style in Template Studio.

## Design Decisions

- **Template-driven, not code-built layout.** The report is a stored DOCX
  template filled by the existing pipeline (`fillTemplate` /
  `fillStoredTemplateDocx`), not a hardcoded folio `Document` built in
  code. This reuses the whole directive grammar (`{{#each}}`, `{{#if}}`,
  AI fields, clause slots), makes the layout org-customizable, and keeps
  one rendering engine. The engine gaps below are closed as general
  template capabilities, not report-specific code.

- **Engine gap 1: `{{#each}}` must repeat table rows and clone tables.**
  `block-directives.ts` today enumerates only `w:p` paragraphs; it cannot
  clone `w:tr` rows nor whole `w:tbl` elements inside a loop body. A DD
  report needs "one row per extracted field" (columns are dynamic per
  view, so a static template cannot enumerate them). Extend the engine:
  an `{{#each}}`/`{{/each}}` pair confined to a single table row clones
  that row per item; a body-level `{{#each}}` block clones all block
  children between the markers (paragraphs AND tables), not just
  paragraphs. Benefits templates generally (party schedules, signature
  blocks, annexes).

- **Engine gap 2: per-item AI fields inside loops.** AI drafting
  (`resolveAiFields`) runs before loop expansion, keyed by flat manifest
  path, so an `aiPrompt` field whose placeholder sits inside `{{#each}}`
  produces one orphaned value (verified: expansion rewrites placeholders
  to synthetic per-row keys that never match). Extend the resolver: when
  an AI field's path points under an array (e.g. `contracts.summary`),
  iterate the array and write the generated value onto each row object;
  `registerItemPatchValues` then picks it up with no loop-engine change.
  Generate per-item drafts with bounded concurrency (they have no
  sequential dependency, unlike top-level fields).

- **Narrative via existing AI template fields, no new AI surface.** The
  executive summary is a top-level `aiPrompt` field (works today: the
  generator receives the whole data object as JSON context); per-contract
  summaries are per-item AI fields (gap 2). Metering, BYOK/instance
  provider, usage preflight, and analytics all come for free from the
  fill pipeline (`modelRole: "fast"`, `feature: "templates.fill"`).
  A deterministic template (no `aiPrompt` fields) exports with zero AI
  calls.

- **The export data object is the contract between view and template.**
  A new builder walks the view server-side (cursor-loop `queryEntities`
  with the view's `filters`/`sorts` and visible `fieldIds` derived from
  `columnOrder`/`hiddenProperties`, batched justification hydration) and
  produces a stable, documented shape:

  ```
  {
    workspace: { name }, generatedAt,
    stats: { total, redFlags, bySeverity: { blocker, high, medium, low } },
    contracts: [{
      index, name, documentType, riskLevel,          // max severity, or "ok"
      summary,                                        // per-item AI field
      fields: [{ label, value, verdict, severity }],
      risks:  [{ severity, issue, verdict, rationale, citation }],
      hasRisks,
    }],
    execSummary,                                      // top-level AI field
  }
  ```

  Risks are derived deterministically: findings with verdict
  `deviation | missing` (from the verdict properties plus
  `playbook-verdict` justification blocks). Views without playbook
  columns simply yield empty `risks`/`verdict` fields; `{{#if}}` in the
  template hides those blocks. No entity/property UUIDs enter the data
  object (AI fields see it as prompt context; use `index` for identity).

- **Export is a queued background job from day one.** A DD view is
  routinely 100+ contracts; per-contract AI fields mean that many model
  calls (20s timeout each), which no synchronous request survives (ALB
  and browser timeouts), and synchronous AI bursts are a known p95
  latency hazard on the API. The export handler enqueues a job (reusing
  the existing background-queue infra that backs extraction /
  file-derivative work, not new infra), returns a job id, and the
  frontend polls a status endpoint. Row cap is a named constant
  (start at 500) so the job stays bounded; exceeding it is a typed
  error, not a truncated report.

- **Default template is an instance-level built-in, clone to
  customize.** The "Due Diligence Report" DOCX asset (using the grammar:
  `{{#each contracts}}` sections, row-repeat field table, `{{#if
  hasRisks}}` risk blocks, AI exec-summary field) ships with the
  deployment and appears in the picker as a built-in, preselected. No
  per-org seeding or backfill; the default improves with releases;
  self-hosters get it for free. "Edit" means cloning it into the org's
  templates (Template Studio), and org report templates appear in the
  picker alongside the built-in. Templates get an explicit `kind` column
  (`document | report`, default `document`) so the picker filters
  structurally.

- **Delivery is the user's choice at export time, converging on S3.**
  The job always writes the generated DOCX to S3. "Save to workspace"
  additionally creates a document entity via `createEntityFromBuffer`
  (opens in folio, versioned, audit-trailed); "download" stores under a
  lifecycle-expired exports prefix and the status endpoint returns a
  presigned URL. No direct byte streaming.

## Scope

**In scope:**

- Engine: `{{#each}}` table-row repeat + table cloning in loop bodies;
  per-item AI field resolution inside loops.
- Report data builder (view → data object) with deterministic risk
  derivation from playbook verdicts + justifications.
- Queued export job (enqueue handler, worker, status endpoint with
  presigned result URL), workspace-scoped, with a persisted export
  record for status + audit.
- Export options: template picker, save-to-workspace vs download, DOCX;
  PDF via Gotenberg is nearly free — include if trivial.
- Built-in DD report template asset; `kind` column on `templates`
  (`document | report`) + migration so the picker filters.
- Frontend: "Export report…" action in the view toolbar (next to Run
  playbook), export dialog (template, delivery), job progress
  (poll status → toast with "open document" / download link).
- Audit-log entry for report generation (report contains extracted
  contract content).

**Out of scope (for now):**

- Flat docs-x-columns grid annex (later template addition once row/table
  repeat exists; likely just a second `{{#each}}` in the template).
- Red-flag-only filtering, per-group export, custom report scoping beyond
  the view's own filters.
- Localized default templates (default ships in en; the grammar and data
  object are language-neutral).
- Raising the row cap / chunked mega-exports beyond the named-constant
  limit.

## Implementation

- `apps/api/src/handlers/docx/block-directives.ts` — row-repeat + table
  cloning for `{{#each}}`; nested-loop support to the extent the field
  table needs (`{{#each contracts}}` outer, row-repeat over
  `contracts.fields` inner). This is the riskiest change; heavy unit
  coverage against real OOXML fixtures.
- `apps/api/src/handlers/docx/resolve-ai-fields.ts` (+
  `ai-field-generator.ts`) — per-item AI resolution for array-scoped
  paths, bounded concurrency, values injected into row objects.
- `apps/api/src/handlers/reports/` (new slice) — `build-report-data.ts`
  (cursor-loop `queryEntities`, justification batches ≤
  `LIMITS.entitiesPageSizeMax`, verdict/risk derivation),
  `export-view.ts` `{ config, handler }` enqueue endpoint via
  `createSafeHandler` (permissions: workspace read; entity create when
  saving to workspace), `read-export.ts` status endpoint (returns state
  + presigned URL / entity id on success), worker module on the existing
  background-queue infra (same backing as extraction /
  file-derivative queues — the implementing slice picks the one that
  fits; no new queue system), `routes.ts` under
  `/workspaces/:workspaceId/reports`.
- Template storage — `kind` column on `templates` (`document | report`,
  default `document`) + hand-authored migration; built-in DD template
  DOCX asset resolved instance-level (no org seeding), exposed in the
  picker and cloneable into org templates.
- `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar.tsx`
  — "Export report…" action; new export dialog component; template list
  via existing template queries (filtered to `kind: report` + the
  built-in); delivery choice; poll job status; invalidate entities on
  save-to-workspace.
- DB schema changes: `templates.kind` column; a workspace-scoped
  `report_exports` table (id, workspaceId, templateRef, status,
  error, resultEntityId / s3Key, requestedBy, timestamps) backing
  status polling and audit. Reports themselves are ordinary document
  entities.

## Test Cases

- Engine: row-repeat clones a `w:tr` per item with per-item placeholder
  rewrite; table inside a body-level `{{#each}}` is cloned intact;
  nested each (contracts → fields) expands correctly; malformed pairs
  (opener inside a row, closer outside) produce structure errors, not
  corrupt XML; numbering and `{{@index}}`/`{{@count}}` behave inside
  cloned rows.
- Per-item AI fields: one generation per row, injected values fill the
  cloned placeholders; top-level AI fields unaffected; deterministic
  templates trigger zero AI calls and skip usage preflight.
- Data builder: honors view filters/sorts/column order/hidden columns;
  risk derivation maps verdicts + justification rationale correctly;
  empty-playbook view yields empty risks and a valid report; caps
  enforced with a typed error above the row limit.
- Handler: workspace isolation (cannot export another workspace's view;
  org template read is read-only cross-scope), permission declarations,
  audit row written, both delivery modes produce a valid DOCX (ZIP
  opens, Word-valid).
- Job lifecycle: status transitions (queued → running → done/failed),
  worker failure surfaces a typed error on the export record (never a
  silently stuck job), row cap exceeded is a typed error at enqueue
  time, presigned URL only issued for the requesting workspace.
- No UUIDs in the AI-visible data object.
