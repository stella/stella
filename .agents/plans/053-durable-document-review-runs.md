# Plan: Durable document review runs

Date: 2026-08-11. Extends `045-playbooks.md` / `047-playbooks-tiered-authoring.md`
and the composable document review slice (PR #1920).

## Goal

A document review becomes a durable, asynchronous, version-pinned record instead
of a 120-second HTTP call whose findings live only in browser memory. One run
executes one confirmed basis (playbook and/or references) against one pinned
document version and lands one finding row per confirmed topic per check kind.
Reload restores in-progress and completed reviews; results remain intelligible
after the playbook, references, or document move on.

Principle carried from the review architecture decision: **data lives in cells,
judgment lives in findings, everything visible is a projection.** This plan
builds the findings side only; extraction columns are untouched.

## Non-goals (this plan)

- Table/bulk run convergence (properties stay canonical there for now)
- Reviewer decision state, stale carry-over across document versions, badges
- Folder consistency, document families, DD report feed
- Reviewer assignments, approval workflows, notifications
- A ReviewFact layer (the `fields` table already is the per-version fact store)

The shapes below must not block any of these (ids everywhere, per-kind outcome
vocabularies, run as provenance rather than the read axis).

## Schema

New file `apps/api/src/db/schema/document-reviews.ts`, `wsPolicies()` RLS on
both tables, hand-authored migration.

### `document_review_runs`

One immutable execution record, modeled on `report_exports` (one-shot job) with
`extraction_runs`-style progress. Columns:

- `id SafeId<"documentReviewRun">`, `organizationId`, `workspaceId`
- Target pin: `entityId`, `fileFieldId`, `entityVersionId`, `contentSha256`
- `basis` jsonb (see below)
- `topics` jsonb: the confirmed topic list (the plan snapshot), max
  `documentReviewTopicsMax`
- `status`: `queued | running | completed | failed | cancelled`, CHECK derived
  from a canonical const (per the #1918 pattern); `errorCode` nullable
- Progress: `total`, `completed` ints, `completed <= total` CHECK
- `requestedBy` FK user SET NULL, `pipelineVersion` int, `modelRef` text
- `createdAt`, `startedAt`, `finishedAt`
- Partial index on active statuses; index `(workspaceId, entityId, fileFieldId,
  createdAt)` for history reads

`basis` jsonb, discriminated like the web `ReviewBasis`:

```ts
type RunBasis =
  | { type: "playbook"; playbook: PinnedPlaybook }
  | { type: "references"; references: PinnedReference[] }
  | { type: "combined"; playbook: PinnedPlaybook; references: PinnedReference[] };

type PinnedPlaybook = {
  definitionId: string;            // plain id, NO FK — runs outlive definitions
  versionId: string | null;        // playbook_definition_versions.id when approved
  provenance: "approved" | "draft";
  definitionSnapshot: { name: string; positions: PlaybookPositions };
};

type PinnedReference = {
  entityId: string; fileFieldId: string; entityVersionId: string;
  contentSha256: string; name: string;
};
```

The snapshot is embedded even when `versionId` is set, so a run is
self-contained: deleting a playbook (whose FK today CASCADEs through
materialized properties) never destroys a run's meaning. Run creation resolves
the latest **approved** snapshot; authors may run a draft, recorded as
`provenance: "draft"`.

### `document_review_findings`

One row per confirmed topic per check kind. Columns:

- `id`, `organizationId`, `workspaceId`, `runId` FK CASCADE
- Denormalized read keys: `entityId`, `fileFieldId`, `entityVersionId`
- `topicId` uuid, `topicTitle` (denormalized for reports), `checkKind`:
  `playbook | reference`, `positionId` nullable (playbook kind only)
- `outcome` text: verdict tiers for playbook kind, the six-value comparison
  vocabulary for reference kind; CHECK per kind derived from the canonical
  consts. Never merged into one vocabulary.
- `payload` jsonb: extracted value, rationale/explanation, verified citations
  (blockId + excerpt), reference citations per file, consensus, severity,
  matchedRef, grounded fix. Shapes reuse the PR #1920 types verbatim.
- `createdAt`; unique `(runId, topicId, checkKind)` — the upsert key

Reads are keyed by document, not run: "current review state" = findings of the
latest completed run per `(entityId, fileFieldId)`.

## Execution

### PR A (mechanical, first): move the engine into `lib/`

The worker cannot import from handlers (`lib-to-handler-imports` ratchet is 0).
Move, without behavior change:

- `handlers/playbooks/review-extract.ts`, `review-grade.ts` →
  `lib/document-review/`
- The comparison core of `handlers/document-reviews/compare-references.ts`
  (prompt build, normalization, evidence verification) →
  `lib/document-review/reference-compare.ts`; the handler stays a thin caller
- `review-selection.ts` resolution helpers likewise

Handlers keep: config, params/body schemas, permission macros, audit calls.

### PR B: runs, worker, endpoints, store

**Queue** `lib/document-review/run-queue.ts`, modeled line-for-line on
`report-export-queue.ts`: BullMQ queue + worker, `jobId = runId` (idempotency),
claim via conditional `queued → running` transition, no-double-run guard (409
while an active run exists for the same `(entityId, fileFieldId)`), orphan
reconciliation interval, failures land `status: failed` + `errorCode` and stay
retryable. Worker: load run → prepare pinned files → playbook and reference
executors in parallel (as the client does today) → upsert findings on
`(runId, topicId, checkKind)` → bump `completed` → mark `completed` only when
the expected set (every confirmed topic × applicable kinds) is committed.
Duplicate jobs converge on the same rows.

**Endpoints** in the `document-reviews` slice:

- `POST .../document-reviews/runs` → resolves selection + pins versions +
  resolves playbook snapshot, inserts run transactionally, enqueues, returns
  `{ runId }` (202). Audit event on create and on completion.
- `GET .../document-reviews/runs/:runId` → run + findings
- `GET .../document-reviews/runs?entityId=&fileFieldId=` → `Page<RunSummary>`
- `/sources` and `/topics` (interactive, cheap) stay synchronous.
- **Delete** `POST /playbooks/:id/review` and the execution half of
  `POST /document-reviews/references`. No back-compat: neither has shipped
  publicly; the web client migrates in the same PR.

**Web**: `playbook-review-store` becomes a cache over server state. Sessions
keyed by `runId`; facet open queries the latest run for the document (suspense
query started per `require-loader-prefetch` rules where a loader exists; the
facet is user-triggered otherwise); poll with `refetchInterval` while
`queued|running`. Reload restores status and findings. `fixState` /
`commentState` stay client-side in this slice (revision ids are
editor-session-scoped; applied tracked changes themselves live in the
document). Topic confirm flow is unchanged; `confirmTopics` now creates the
run.

MCP classification: `internal / document_processing` like the existing slice;
regenerate the MCP coverage baseline.

## Deletion + retention semantics

- Playbook deleted → runs/findings untouched (snapshot embedded, no FK)
- Reference or target document deleted → findings untouched; UI marks the
  source unavailable when resolution fails
- Workspace deletion cascades everything (existing tenant semantics)
- `entity_versions` are already never hard-deleted; version pins stay valid

## Risks / open edges

- The run worker is a new consumer adjacent to `finishWorkflow`; per the 047
  deferred finding, a third inline post-completion consumer should trigger
  extracting a completion-hook registry. This worker is a separate queue, so it
  does not add one — keep it that way.
- Mock AI returns `{}` for structured output (known dev gap); dev-loop testing
  of the worker needs the same workaround as the verdict engine.
- `ci-checks` OOM flake on web-heavy PRs; PR B touches web moderately.

## Success signals

- Reload mid-run restores "reviewing" and then the same findings
- Retry/duplicate jobs never duplicate finding rows
- Every confirmed topic has exactly one finding per applicable kind
- A completed review renders after its playbook is deleted
- Zero properties created by a 200-position review
