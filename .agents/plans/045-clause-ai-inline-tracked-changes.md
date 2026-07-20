# Plan: Clause AI edits as inline tracked changes

Date: 2026-06-26

## Goal

Replace the Clauses "edit with AI" all-or-nothing accept/decline (a separate
read-only diff pane + whole-body swap) with the Folio gesture: AI edits land
inline in the clause editor as tracked changes (insertion/deletion marks) that
the user accepts or rejects per change. Achieve this DRY by sharing Folio's
ProseMirror suggestion infrastructure rather than building a parallel system.

## Design Decisions

- **Reuse Folio's ProseMirror suggestion stack, not a fork.** The clause editor
  is already TipTap (ProseMirror under the hood) with `clauseBodyToTipTap` /
  `tipTapToClauseBody` converters. Folio's `insertion`/`deletion` marks, the
  `suggestionMode` plugin, the `acceptChange`/`rejectChange`/`acceptAllChanges`/
  `rejectAllChanges` commands, and `diffWordSegments` are schema-light / pure —
  they depend only on the two marks + `prosemirror-*`, not on the DOCX schema
  (`paraId`/`numPr`/`styleId`). So they can be registered into the clause
  editor's TipTap schema directly.
- **Skip Folio's DOCX-coupled apply engine.** `applyFolioAIEditOperations` and
  `createFolioAIEditSnapshot` require DOCX node attrs; clauses don't have them.
  Instead, apply the AI's revised paragraphs into the clause doc _with
  suggestionMode active_, so ordinary replace/insert/delete transactions are
  auto-converted into tracked-change marks. No operation/snapshot schema needed.
- **Inline only, no side review panel.** A clause has a handful of hunks at most;
  per-change accept/reject in the editor + accept-all/reject-all in the toolbar
  is enough. Do **not** fork `review-panel.impl.tsx` (it is coupled to
  `docxEditorRef` and would create a second copy — anti-DRY).
- **Delete the bespoke parallel diff.** `clause-diff.ts`, `clause-diff-view.tsx`,
  and the all-or-nothing `acceptAiEdit()` path are replaced by shared infra, so
  they are removed (net negative LOC).
- **Backend unchanged.** `rewrite.ts` already returns changed paragraphs keyed by
  index — exactly the grain the apply glue needs. No API change.
- **Block save while changes are pending.** Save is disabled until every AI
  tracked change is accepted or rejected. A clause is a small canonical snippet
  reused across documents, so it must be fully resolved before it is stored —
  better a brief friction wall than silently baking in (or persisting) undecided
  redlines. Rules out auto-accept-on-save and persisting pending marks (the
  latter would also need a `ClauseRun` model change, out of scope).

## Scope

**In scope:**

- Promote Folio's suggestion primitives to `@stll/folio` package exports.
- Register the marks + suggestionMode plugin into the clause TipTap editor.
- Apply-with-suggestionMode glue (baseline → revised as tracked changes).
- Inline per-change accept/reject affordance + toolbar accept-all / reject-all.
- Collapse the `AiEditState` machine (no separate preview pane).
- Remove the bespoke diff files and old accept path.

**Out of scope:**

- Side review-panel / suggestion list for clauses.
- Any change to `rewrite.ts` request/response shape or the AI prompt.
- A persistent "track changes" toggle for manual (non-AI) clause editing — this
  plan uses suggestionMode only as the AI-apply mechanism.
- Tracked-change persistence across save: accepted text is saved; the design
  question of saving _pending_ marks is deferred (see Open Questions).

## Implementation

### `packages/folio` — export surface (re-export, not rewrite)

Currently `src/index.ts` exports the `ai-suggestions/*` layer but **not** the raw
prosemirror suggestion pieces, and `package.json` exports only `.`, `./markdown`,
`./server`, `./editor.css`.

- Export from `@stll/folio` (via `src/index.ts`, or a dedicated
  `./track-changes` subpath export to keep the surface tidy):
  - `InsertionExtension`, `DeletionExtension`
    (`core/prosemirror/extensions/marks/TrackedChangeExtensions.ts`)
  - `suggestionMode` plugin + `suggestionModeKey` and the meta constants
    (`core/prosemirror/plugins/suggestionMode.ts`)
  - `acceptChange`, `rejectChange`, `acceptAllChanges`, `rejectAllChanges`
    (`core/prosemirror/commands/comments.ts:417-524`)
  - `diffWordSegments` is already exported.
- **Verify** `createMarkExtension` (used by `TrackedChangeExtensions.ts`) yields a
  TipTap-compatible extension; if it produces a raw ProseMirror mark spec, add a
  thin TipTap `Mark.create()` wrapper (or a single TipTap `Extension` that
  injects both mark specs + the plugin via `addProseMirrorPlugins`). Confirm the
  small internal deps travel cleanly: `splitBlockClearBorders`
  (`BaseKeymapExtension`), `TrackedChangeInfo` type, `authorColors` util.

### `apps/web` — clause editor

`apps/web/src/routes/_protected.knowledge/-components/clause-editor.tsx`

- Add the insertion/deletion marks + a suggestionMode TipTap extension to the
  `useEditor` extensions list. suggestionMode stays **inactive** during normal
  editing; it is toggled on only while applying an AI edit.
- New apply glue (replaces `runRewrite` → `setAiEdit({status:"preview"})` →
  `acceptAiEdit`): after the API returns the revised `ClauseBody`, activate
  suggestionMode (author = current user) and write the diff into the live doc so
  it becomes tracked changes. Use the backend's changed-paragraph indexes to
  scope edits; within a changed paragraph, use `diffWordSegments(old, new)` to
  emit minimal word-level replacements (Folio-quality redline) rather than
  whole-paragraph delete+insert. Added/removed paragraphs become block
  insert/delete under suggestionMode.
- Inline accept/reject UI: clicking a tracked-change run (or a small hover
  affordance) runs `acceptChange(from,to)` / `rejectChange(from,to)`. Toolbar
  gains accept-all (`acceptAllChanges()`) and reject-all (`rejectAllChanges()`),
  shown only while pending marks exist.
- `onChange(tipTapToClauseBody(...))` fires as the user accepts/rejects, so the
  parent always holds the resolved body. Ensure `tipTapToClauseBody` ignores /
  resolves any leftover mark wrappers (insertion → keep text, deletion → drop
  text) as a safety net at save.
- **`AiEditState` collapse:** `idle | prompting | generating | preview` →
  `idle | prompting | generating` (and an implicit "has pending changes" state
  derived from whether tracked-change marks exist in the doc, not a stored
  blob). The `baseline`/`revised` `ClauseBody` snapshots in the state object are
  no longer needed — the doc itself is the source of truth.

**Deletions:**

- `apps/web/src/routes/_protected.knowledge/-components/clause-diff.ts`
- `apps/web/src/routes/_protected.knowledge/-components/clause-diff-view.tsx`
- The `acceptAiEdit()` whole-body-swap path and its imports in
  `clause-editor.tsx` (lines ~46-47 import block + the preview render block).

### CSS

- Reuse Folio's tracked-change styling. `clause-editor.css` may need the
  insertion/deletion span styles (or import the relevant rules) so the marks
  render with the standard underline/strikethrough + author color, consistent
  with Folio.

### DB / schema

- None.

## Test Cases

- `diffWordSegments`-driven apply: a multi-paragraph clause where the AI changes
  2 of 4 paragraphs produces tracked changes only in those 2 (others untouched).
- Accept one change, reject another → resolved `ClauseBody` reflects exactly the
  accepted subset; `onChange` payload is correct.
- Accept-all / reject-all resolve every pending mark; reject-all returns the body
  to baseline byte-for-byte.
- Directive paragraphs (`{{#if}}` etc., `ClauseDirectiveNode`) are preserved and
  never wrapped in tracked-change marks (backend already excludes them; assert
  the apply glue can't touch them).
- `tipTapToClauseBody` with leftover insertion/deletion marks resolves correctly
  (insertion text kept, deletion text dropped) as a save-time safety net.
- Added-paragraph and removed-paragraph cases (not just in-place edits).
- suggestionMode is inactive during normal typing (no accidental marks when the
  user edits a clause by hand).
- Save is blocked while any pending tracked-change mark exists; it re-enables
  once all changes are accepted or rejected (and after reject-all returns to
  baseline).

## Implementation Notes (as built)

Three plan assumptions changed once the code was inspected; the user-facing
shape (inline tracked changes, per-change + all accept/reject, block-save) is
unchanged.

- **The `suggestionMode` plugin is not reused.** It is built for interactive
  typing, is welded to Folio's `pPrMark` paragraph schema, and its programmatic
  path only auto-marks insertions (not deletions). Instead the AI revision is
  applied by building a tracked-change TipTap doc directly (`buildTrackedChangeDoc`
  - `diffWordSegments`) and `setContent`-ing it with `emitUpdate: false`.
- **Marks are a thin TipTap shim, not Folio's marks.** Folio's
  `InsertionExtension`/`DeletionExtension` use Folio's bespoke extension system
  (`createMarkExtension` → `onSchemaReady`), not TipTap. `clause-tracked-change-marks.ts`
  re-declares `insertion`/`deletion` as TipTap marks mirroring the same schema
  (mark name + `revisionId`/`author`/`date` + `docx-insertion`/`docx-deletion`
  classes) so the shared resolution commands match them. The bug-prone logic —
  `acceptChange`/`rejectChange`/`acceptAIEditRevision`/`rejectAIEditRevision` and
  `diffWordSegments` — is reused from the published Folio packages. After the
  monorepo Folio extraction, resolution commands come from
  `@stll/folio-core/prosemirror/commands/comments` and the word diff comes from
  `@stll/folio-react`; no removed `packages/folio` source is restored.
- **`clause-diff.ts` / `clause-diff-view.tsx` are NOT deleted.** They are still
  used by `clause-detail.tsx` for version comparison; only the AI-edit usage was
  removed from `clause-editor.tsx`.
- **No add/remove paragraph handling needed.** `rewrite.ts` returns an
  index-aligned body (same length/structure; the model is instructed not to
  add/remove paragraphs), so a paragraph is "changed" iff its text differs at the
  same index.
- **i18n reuses existing keys** (`common.accept`,
  `docxReview.{reject,acceptAll,rejectAll}`, `clauses.noChanges`) rather than
  adding duplicates that the common-overlap gate would flag; one new key,
  `clauses.aiStructureChanged`, explains a rejected structurally misaligned
  rewrite.
- **Review mode makes the editor read-only** (`setEditable(false)`); accept/reject
  run as programmatic commands. `onUpdate` suppresses autosave while any tracked
  mark remains (block-save) and finalises — re-enabling editing + emitting the
  resolved body — once none remain.
