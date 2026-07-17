# 050 — DOCX Suggestion Review UX (in-document pending changes)

## Problem

AI-proposed DOCX edits are reviewed out of context: they exist only as cards in the
inspector ReviewPanel, invisible in the document until accepted. Accepting creates a
second reviewable layer (a real tracked change) with the same verb, which is
confusing. Review state is in-memory only (lost on reload), there is a meaningless
chat approval gate before the meaningful Accept, and there is no keyboard or
sequential flow for large batches (up to 200 ops).

## Target model

Two explicit layers sharing the tracked-changes visual grammar (inline strikethrough
old / underline new), distinguished by one visual bit:

- **Suggestion (pending):** dotted stroke, AI accent hue, tinted range. Present in
  the editor document (and collab doc) but **never in serialized DOCX bytes**.
- **Redline (durable):** solid stroke, `--tc-color`, authored as the human reviewer.
  Unchanged from today.

Accept converts a suggestion into a redline tracked change (authored as the user);
reject removes it. Rule the user learns once: dotted = proposed, solid = in the file.

## Architecture decision: provisional marks, not overlay decorations

Considered: (a) non-mutating decoration overlay fed by dry-run slices
(`previewFolioAIEditOperations` + `aiSuggestionDecorations` plugin), (b) applying
pending ops into the document as tracked changes carrying a suggestion provenance
attribute, stripped at serialization.

Chose **(b)**. Rationale:

- The paged editor renders via rect projection; an overlay cannot reflow pagination,
  so block-level ghosts (suggested tables, new clauses) would be floating
  approximations. Provisional marks give true inline rendering for every node type
  with correct pagination and numbering ripple, using the existing tracked-change
  renderer.
- Staleness machinery (`resolveSuggestionAnchor`, context windows) becomes
  unnecessary: ProseMirror/Yjs remap marks under concurrent edits automatically.
- Accept is an attribute rewrite (provenance + author), reject reuses the existing
  `rejectChange` semantics.
- Suggestions sync to collaborators via Yjs for free, gated by the same
  entity-update permission as editing.

Leak-risk class and its guard: any serialize path that forgets to strip provisional
content would leak AI-proposed text into an exported DOCX. Guard: stripping is the
**default** inside the single serializer entry (`fromProseDoc` boundary), opt-out
only via an explicit internal flag; tests assert no provisional marks survive
serialization across checkpoint, finalize, export, and copy/paste paths.

## Decisions (agreed with maintainer)

1. Apply-mode (tracked vs direct/clean) surfaced prominently in the review bar.
2. Rationale lives in an anchored hover/click card in the document (primary) and the
   panel card (secondary). No margin comments.
3. Suggestions survive reload: metadata + op payload persisted server-side
   (`docx_suggestions` table) so sessions can rehydrate; audit trail of who
   accepted/rejected what.
4. Accept all: one click up to ~10 pending; above that, a confirm dialog summarizing
   counts by severity.
5. Presentation of any replace: tracked-changes grammar inline (no stacked cards, no
   third visual style). Simple Markup collapses suggestions to change bars; Original
   hides them.

## Phases

### P1 — Stella-only review flow (ships alone, no folio change)

- Remove the redundant chat approval gate for `apply-active-docx-edits`
  (queue-only tool; auto-run its client executor).
- Floating review bar in the DOCX editor (bottom-center pill): "N of M suggestions",
  prev/next, Accept, Reject, Accept all (threshold confirm), apply-mode toggle.
- Keyboard: Cmd/Ctrl+Enter accept-and-next, Cmd/Ctrl+Backspace reject-and-next,
  Alt+Up/Down navigate. Active only while suggestions are pending.
- Panel keeps grouping/triage; bar and panel share the review-store.

### P2 — Folio suggestion layer (folio repo)

- New apply mode `"suggested"` in `FolioAIEditApplyMode` reusing the
  tracked-changes appliers; `insertion`/`deletion` (and `runPropertyChange`) marks
  gain a `provenance: "user" | "suggested"` attr plus `suggestionId`.
- CSS: dotted stroke + suggestion hue for provenance=suggested in both DOM editor
  and paged renderer (existing class contract); markup-view modes honor it.
- Serializer strips provenance=suggested by default (insertions omitted, deletions
  restored to plain text) + leak tests.
- Commands: `acceptSuggestion(id | range, { author })` → rewrite to real tracked
  change; `rejectSuggestion` → existing reject semantics; accept/reject-all.
- `DocxEditorRef` additions: apply in suggested mode, list suggestions, navigate,
  accept/reject by suggestionId. Changesets per package.

### P3 — Folio block/table coverage

- Enable block ops (`insertAfterBlock`, `replaceBlock`, `deleteBlock`,
  `insertSignatureTable`) and table ops in suggested mode (row-level `<w:ins>`
  semantics where applicable; whole-node insertion marks otherwise).
- `formatRange` rejoins the review flow as suggested `runPropertyChange`.
- Severity vocabulary unified on `low | medium | high` (folio adopts the tool's).
- `<w:initials>` on tracked changes (extend `TrackedChangeInfo` + serializer +
  mark attrs).

### P4 — Stella integration + persistence

- Review panel/store drive the suggested mode; hover card anchored to suggestion
  marks with rationale + Accept/Reject; bidirectional focus sync panel <-> doc.
- `docx_suggestions` table: workspace/entity FK, op payload, severity, area, status
  discriminator (`pending | accepted | rejected`), origin thread id, resolvedBy,
  timestamps. Cursor-paginated list endpoint (`Page<T>`). Rehydration re-applies
  pending payloads in suggested mode when a session opens without them.
- Finalize flow warns when suggestions are still pending (soft note; they are
  stripped from the bytes either way).
- Rejection feedback surfaced to the chat thread.

## Success signals

- A suggested table renders inline, paginated correctly, dotted, before acceptance.
- Exported/checkpointed DOCX bytes never contain pending suggestion content
  (asserted by tests).
- Reviewing a 20-op batch is a keyboard-only loop.
- Suggestions survive reload and are auditable (who resolved what, when).

## Out of scope (for now)

- Multi-user review queues / per-suggestion assignment.
- Editing inside a pending ghost (accept first, then edit the tracked change).
- Streaming application while the model is still generating.
