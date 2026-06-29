# Plan: Playbooks (positions, clause-linked review)

Date: 2026-06-29

## Goal

Evolve the current "playbook = doc-type extraction column bundle" into a
first-class **Playbook** primitive: a saved, scoped, versioned set of
**Positions** that ask graded questions of a contract and can run against a
single file (inline review + redline) or a whole files table (compliance
matrix). The playbook adds *policy* on top of primitives we already have
(extraction, condition AST, clause library, clause-to-patch); it does not
introduce a new evaluation engine.

## Core model

A **Position** is the atom. It has four facets, each backed by an existing
primitive:

- **ASK** — a question answered per document. Reuses the property/extraction
  engine (today's `bundle` column `prompt`).
- **EXPECT** — the answer key. A discriminated union `standard.source`:
  - `clause` — references an org clause (preferred = `clause.body`, fallbacks
    = `clauseVariants` ordered by `sortOrder`, guidance = `clause.metadata`),
    pinned to a `clauseVersion`.
  - `inline` — preferred + ranked fallbacks typed on the position itself.
  - `none` — no language; the rule is the standard (pure assertion).
- **GRADE** — `rule.kind` discriminated union over how to judge ASK vs EXPECT:
  - `presence` — clause must be present / absent.
  - `propertyConstraint` — extracted value checked via the condition AST
    (`@stll/conditions`), no LLM.
  - `positionMatch` — extracted prose compared to preferred/fallbacks (LLM),
    returns a tier. Plus `severity` (blocker | high | medium | low).
- **FIX** — insert preferred language as a tracked change via the Folio editor's
  `applyAIEditOperations({ mode: "tracked-changes" })`, mirroring the chat
  AI-review pipeline. (NOTE: `clause-to-patch` is server-side DOCX template-fill,
  NOT live-editor redline — do not use it here.) Structurally available only when
  EXPECT is `clause | inline`.

`RUN(Playbook, Target)` produces **Findings**, the single output unit:
`{ positionId, documentId, extracted, verdict, severity, citation, fix? }`.
`verdict ∈ compliant | fallback | deviation | missing`. Evaluation is
N-agnostic (1 doc or N docs) and surface-agnostic; only the renderer differs.

## Design Decisions

- **Playbook definition is an org-scoped knowledge primitive; runs are
  workspace-scoped.** The definition joins clauses/templates/skills under
  `/knowledge` (org-level, reusable across matters). Running a playbook
  (materialized columns, findings, redlines) lives in a workspace where the
  documents are. This resolves the org/workspace seam cleanly and is what
  the "Playbook in the Tools section" ask implies. It supersedes the earlier
  "playbooks stay workspace-scoped" lean. Per-matter/counterparty targeting
  becomes a *run-time* parameter plus optional scope filters on the
  definition, not a reason to keep the definition workspace-bound.

- **Two orthogonal discriminated unions** (`standard.source`, `rule.kind`)
  rather than one fat object with optional fields. Invalid combinations
  (constraint check on prose, "insert preferred" with no language) do not
  compile. Matches house style (strict typing, unrepresentable bad states).

- **Reference, do not copy, clause language.** Positions hold a clause ref +
  pinned version, never a duplicate of the prose. Edit the standard once in
  the library; every referencing position updates. `inline → save to library`
  is a one-way promotion, never a prerequisite.

- **The new model is a superset of today's bundle.** An extraction column is
  just a Position with ASK only (`rule.kind` absent / `standard.source:
  none`, no grade). Existing `bundle` rows migrate to ASK-only positions; the
  JSONB shape gets a `version` tag with a compat read path.

- **No new engines.** Read = properties + extraction workflow; gate/grade =
  `propertyDependency` + condition AST (already powers #803 doc-type gating);
  language + versioning = clause library + `clauseVersions`; apply fix =
  `clause-to-patch`; table render = views/grid + provenance card; tenancy /
  pagination / audit = RLS + `Page<T>` + audit-log.

- **Verdict is its own derived column** (single-select property depending on
  the extraction property via `propertyDependency`); rationale + citation
  ride in the existing AI-cell provenance card, not a third column.

## Scope

**In scope (overall feature):**

- Org-scoped Playbook + Position data model (discriminated unions, version-
  tagged JSONB), CRUD, and the knowledge-primitive UI ("fill it in").
- Run on a files table (compliance matrix) and run on a single file (issue
  cards + inline redline).
- Playbook versioning; per-matter/counterparty scope + conditional triggers.
- Clause-linked, inline, and none standard sources; FIX via clause-to-patch.
- Migration of the existing workspace `playbooks` (column bundles) into the
  new model.

**Out of scope (for now):**

- Word/Outlook add-in (project non-goal).
- Multi-round negotiation memory / counterparty correspondence.
- Auto-applying redlines without confirmation (always suggest-and-confirm).
- AI-bootstrap a playbook from a corpus (later authoring path; design the
  model so it slots in, but do not build it in the first slices).

## Implementation

### Data model (`apps/api/src/db/schema.ts`, new migration dir)

- New org-scoped definition: either migrate `playbooks` to `organizationId`
  or add `playbook_definitions` (org-scoped) and retire the workspace table.
  Columns: `id`, `organizationId`, `name`, `description`, `scope` (jsonb:
  doc-type + triggers + counterparty/matter), `positions` (jsonb: version-
  tagged `Position[]`), timestamps. Indexes for org-scoped cursor pagination.
- `playbook_versions` mirroring `clauseVersions` (diff/restore), so a run can
  pin a playbook version and a position can pin a `clauseVersion`.
- Keep run-time artifacts workspace-scoped: reuse `properties` +
  `playbook_source_id` for materialized columns; add a `findings` shape
  (could be derived/cached rather than a table in the first table-run slice).
- RLS: playbook definition org-scoped; clause refs are read-only cross-scope
  (a workspace run reads the org clause library; never writes it).

### Position / standard types (`apps/api/src/db/schema-validators.ts`)

- Evolve `PlaybookBundleColumn`/`PlaybookBundle` into `Position` /
  `PositionStandard` / `PositionRule` discriminated unions with a `version`
  discriminator on the array; add a compat reader that lifts v1 columns to
  ASK-only positions.

### Backend handlers (`apps/api/src/handlers/playbooks/`)

- Re-scope CRUD to org (`createSafeRootHandler` / org-scoped safe handler),
  `Page<T>` cursor read, audit-log on mutations, permission declarations.
- `apply.ts` rework: resolve each position's standard, materialize ASK
  (extraction property) + GRADE (verdict single-select property) wired by
  `propertyDependency`, trigger the extraction workflow; emit Findings.
- New evaluator module (GRADE): deterministic path via condition AST;
  `positionMatch` via LLM (reuse the AI catalog + quality-gate pattern).
- Single-file run handler producing Findings for one document; FIX via
  `clause-to-patch`.

### Frontend (`apps/web/src/routes/_protected.knowledge/`)

- New route `playbooks.tsx` (org-scoped, mirrors `clauses.tsx`: list +
  detail + form, cursor pagination, skeleton). Nav entry in
  `components/workspace-primary-nav.ts`; breadcrumb in
  `components/breadcrumbs/`. Queries + keys in `-queries`.
- `-components/playbook-list.tsx`, `playbook-detail.tsx`,
  `playbook-form-dialog.tsx`, and a `position-editor.tsx` exposing the four
  facets (ASK question + content type; EXPECT source picker with clause
  selector / inline / none; GRADE rule kind + severity; guidance).
- Run surfaces (later slices): table run wired from the view toolbar
  (replacing today's `playbooks-manager.tsx` table-only entry); single-file
  run as an issues panel in the folio editor with inline redline.

## Slices (sequencing)

1. **Authoring primitive (kickoff).** Org-scoped Playbook + Position model,
   CRUD, knowledge route + nav + breadcrumb, list + editor shell with the
   four-facet fields and a clause picker. User can create playbooks and fill
   in positions. No run yet. Migrate existing bundle rows to ASK-only
   positions.
2. **Run on a files table.** Materialize ASK + verdict columns, reuse
   condition-AST gating and the extraction workflow, render the compliance
   matrix; provenance card carries rationale + citation.
3. **Run on a single file.** Findings to issue cards in folio + inline citation
   (driven by the ASK extraction's docx-folio block-id citations); one-click
   redline via the editor's `applyAIEditOperations` tracked-changes path (mirror
   the chat review-store -> inspector Suggestions -> review-panel pipeline).
4. **Versioning + scope axes.** Playbook versions, counterparty/matter scope
   + conditional triggers, pin-to-clause-version.
5. **Governance + authoring polish.** RBAC, audit surfacing, inline→library
   promotion, AI-bootstrap from a reference contract.

## Test Cases

- Position union: invalid combinations rejected at the schema boundary
  (`propertyConstraint` with prose-only standard; FIX requested on
  `source: none`).
- JSONB version compat: v1 bundle columns read back as ASK-only positions.
- `apply.ts`: idempotent re-apply by `sourceId`; verdict property depends on
  the extraction property; gating condition matches doc type.
- GRADE evaluator: deterministic constraint outcomes via condition AST;
  tiering for `positionMatch` (compliant / fallback / deviation / missing).
- Finding shape stable across single-file and table runs (same evaluator).
- RLS: workspace run can read but not write the org clause library; org
  isolation on playbook definitions.
- Cursor pagination + `Page<T>` envelope on the org-scoped list.

## Open Questions

- Migration of existing workspace `playbooks`: how much production data
  exists, and do we move definitions to org scope in place or introduce a new
  table and backfill? (Affects whether slice 1 is additive or a rename.)
- Findings: cached/derived per run, or a persisted `findings` table from the
  start (needed for matrix sort/filter at scale and for single-file history)?
- Does `guidance` get promoted from `clause.metadata.custom` to a typed field
  so it can drive the GRADE prompt deterministically?

## Slice 2 design (files-table run + verdict engine)

RUN is a workspace-scoped action over an org-scoped definition:
`POST /workspaces/:workspaceId/playbooks/:playbookId/run`. It reads the org
playbook (cross-scope read, RLS allows org member), resolves each clause-source
standard (clause body + variants at the pinned version) and snapshots it, then
materializes per position and starts the existing workflow. Workspace-wide for
slice 2 (no doc-type/scope gate yet; that is slice 4).

**Verdict = a new `playbook-verdict` property tool** (extend
`propertyToolSchema`), carrying `{ askPropertyId, rule (reuse positionRuleSchema),
severity, standard (snapshot) }`. Per graded position, RUN materializes two
properties:
- the **ASK** property (ai-model or manual-input, exactly as the old apply did),
  `playbookSourceId = position.sourceId`.
- the **verdict** property (content = single-select `compliant | fallback |
  deviation | missing`), `playbookSourceId` = a derived/namespaced id from the
  position so re-runs stay idempotent. It gets a `propertyDependency` on the ASK
  property, so the execution-plan DAG schedules it in a later level
  (`get-execution-plan.ts`). `extractOnly` positions create no verdict property.

**Executor branch**: the batch processor dispatches on `tool.type`:
- `ai-model` -> existing LLM extraction (unchanged).
- `playbook-verdict` -> grade `askValue` against `rule`/`standard`:
  - `presence` -> deterministic (value present/absent vs required/restricted).
  - `propertyConstraint` -> evaluate the condition AST over the ASK field
    (`evaluateGatingCondition` is the reusable evaluator); no LLM.
  - `positionMatch` -> targeted LLM call comparing ASK value to
    preferred/fallbacks, returning tier + rationale (reuse the extraction
    plumbing + justification rows for citation/rationale).

Files to touch: `schema-validators.ts` (+ verdict tool), `db/schema.ts`
(possibly a `playbook_role` discriminator or rely on derived source id),
`workflow/get-execution-plan.ts` (include verdict tools in the DAG),
`workflow-queue.ts` / `generate-batch-shared.ts` (tool-type dispatch + verdict
eval), rebuilt `apply.ts` as the workspace run handler, a new workspace-scoped
run route, and frontend: a "Run playbook" action in `view-toolbar.tsx` (pick an
org playbook -> call run -> invalidate properties) plus verdict-cell rendering
(single-select chip + a verdict provenance card variant of `ai-cell-source-card`).

Open verdict questions: (a) `playbook_role` column vs namespaced `playbookSourceId`
to distinguish ASK vs verdict materialized props; (b) whether the verdict's
positionMatch prompt is auto-generated from the standard or templated;
(c) re-run semantics when a definition changed after a prior run (idempotent
upsert + mark stale).
