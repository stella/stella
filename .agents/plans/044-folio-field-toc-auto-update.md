# Plan: Folio Field & TOC Auto-Update

Date: 2026-06-08

## Goal

Make folio's dynamic DOCX fields compute live values and regenerate instead of
rendering only their parsed fallback text: cross-references and counters
(`PAGEREF`, `REF`, `SEQ`, `SECTIONPAGES`) resolve correctly, page-number fields
honour their format switches, and a `TOC` field generates entries with live page
numbers. Today only `PAGE`/`NUMPAGES`/`DATE`/`TIME` resolve, and every other
field paints stale cached text.

## Background (current state, verified)

- Model: `SimpleField`/`ComplexField` in `@stll/docx-core`
  (`packages/docx-core/src/model/content.ts`) carry `instruction`, `fieldType`,
  and cached result runs.
- Parse: `core/docx/fieldParser.ts` already parses instructions, switches, and
  has `computePageNumber`/`formatDate` helpers — but they are barely wired in.
- **Identity loss**: `core/layout-bridge/toFlowBlocks.ts` collapses every field
  to `FieldRun.fieldType` of `PAGE | NUMPAGES | DATE | TIME | OTHER`
  (`layout-engine/types.ts:237`). Instruction, switches, and the real type are
  dropped, so the painter cannot evaluate `SEQ`/`PAGEREF`/etc.
- Eval today: an ad-hoc `switch` in `layout-painter/renderParagraph.ts`
  (`renderFieldRun`) substitutes only PAGE/NUMPAGES (from
  `RenderContext.pageNumber/totalPages`) and DATE/TIME (`new Date()`).
- **Width skew**: measurement uses `run.fallback` width
  (`measureParagraph.ts`), but paint uses the live value. When widths differ
  (e.g. fallback `1`, live `12`; TOC page numbers; dot leaders) the line is
  mismeasured. No re-layout pass corrects this.
- TOC scaffolding exists but is static: `core/utils/headingCollector.ts`
  (outline via `outlineLevel` + `HeadingN` styleId) and a user-invoked
  `generateTOC` command; `HeadingInfo.pageNumber` is never filled because there
  is no bookmark/heading -> page map.
- No bookmark -> page map and no iterate-to-stable relayout loop exist.

## Design Decisions

- **Carry field identity into the layout, don't collapse it.** Widen `FieldRun`
  to keep `instruction` + the full `fieldType` (or a pre-parsed
  `ParsedFieldInstruction`) so a single evaluator can compute any supported
  field. This is the enabling change; everything else builds on it. Aligns with
  the repo rule "thread the discriminator through the full stack."
- **One evaluator, not scattered switches.** Replace `renderFieldRun`'s inline
  switch with `evaluateField(parsed, ctx)` in a new
  `core/layout-engine/fields/` module (pure, React-free, unit-testable — same
  posture as the just-extracted `measureBlocks`). The painter calls it; so does
  the measure pass (see next point).
- **Resolve fields against a real layout via a bounded iterate-to-stable loop.**
  Page numbers depend on layout; layout depends on text widths which depend on
  field values which depend on page numbers. Mirror Word: layout once with
  best-known values, build the field-resolution context (page map, bookmark
  map, SEQ counters), re-measure only paragraphs whose field values changed
  width, re-layout, repeat until stable or a small cap (3) is hit. Most
  documents converge in 1; header/footer page numbers are width-stable.
- **Expose a bookmark/heading -> page map from pagination.** The paginator
  already assigns `Page.number`; record, per bookmark id and per heading
  anchor, the page it lands on. This single map powers `PAGEREF`, `REF`, and
  TOC entries.
- **TOC is generated as real editable doc content, built on the same
  primitives, in one PR.** Generation needs the outline (already collected) +
  the page map + the iterate-to-stable loop (inserting entries shifts pages).
  TOC entries are real PM paragraphs in the document model (not a layout-only
  synthetic block) so they match Word, round-trip to DOCX, and stay editable.
  Shipped in the same PR as the field foundation, but built in that order
  (foundation first, then TOC on top) so the foundation is testable before TOC
  is layered on.
- **Preserve round-trip.** Keep emitting `w:instrText` + `fldChar` unchanged;
  update the cached result run text to the computed value and mark `dirty` so
  Word re-evaluates on open. Do not regress `@stll/docx-core` serialization.

## Scope

One PR, built in two stages (foundation, then TOC on top).

**Stage 1 — field evaluation foundation:**

- Widen `FieldRun` (instruction + full type + switches) and stop the `OTHER`
  collapse in `toFlowBlocks.ts`.
- New `core/layout-engine/fields/evaluateField.ts` evaluator + `FieldContext`
  (page number, total pages, section pages, bookmark map, SEQ counters, now).
- Support: `PAGE`, `NUMPAGES`, `SECTIONPAGES` with `\*` numeric-format switches
  (arabic/ROMAN/alphabetic); `PAGEREF`/`REF` via the bookmark->page map; `SEQ`
  via a document-order counter pass; `DATE`/`TIME`/`CREATEDATE`/`SAVEDATE` with
  `\@` format codes (reuse `fieldParser.formatDate`).
- Bookmark/heading -> page map produced during pagination and exposed on
  `Layout`.
- Bounded iterate-to-stable relayout loop in the layout driver (cap 3, converge
  on no width-affecting field change).
- Painter + measure both call the evaluator (measure uses the
  current-best-context value so widths track paint).
- Golden test on the deterministic harness.

**Stage 2 — live TOC (same PR):**

- `TOC` field generation: outline (`\o "1-3"`) -> entries as **real PM
  paragraphs** (text + right tab with dot leader + live `PAGEREF` page number),
  regenerated through the iterate-to-stable loop and round-tripped to DOCX.
- Make the existing `generateTOC` command emit live entries (or supersede it).

**Out of scope:**

- `IF`/conditional logic, `MERGEFIELD`/mail-merge, `INCLUDETEXT`/
  `INCLUDEPICTURE`, `INDEX`/`TOA`, `STYLEREF`, nested/calculated fields.
- User-facing "update fields" affordances beyond automatic recompute on layout.
- Numbering-restart/legal-numbering (separate roadmap item).

## Implementation

- `packages/folio/src/core/layout-engine/types.ts` — widen `FieldRun`
  (`instruction: string`, full `fieldType`, parsed switches); add a
  `bookmarkPages` / `headingAnchors` map type on `Layout`.
- `packages/folio/src/core/layout-bridge/toFlowBlocks.ts` — stop collapsing to
  `OTHER`; thread instruction + type from the PM `field` node attrs into
  `FieldRun`. Emit bookmark anchors as positioned markers the paginator can map.
- `packages/folio/src/core/layout-engine/fields/evaluateField.ts` (new) +
  `fieldContext.ts` — pure evaluator and context builder. Reuse
  `core/docx/fieldParser.ts` (`parseFieldInstruction`, `computePageNumber`,
  `formatDate`); move/share those compute helpers if cleaner.
- `packages/folio/src/core/layout-engine/index.ts` / paginator — assign
  bookmark/heading pages during pagination; return the map.
- The layout driver that calls `measureBlocks` + `layoutDocument` (in
  `paged-editor/PagedEditor.tsx`, or extracted alongside the measurement module)
  — add the bounded re-evaluate/re-measure/re-layout loop.
- `packages/folio/src/core/layout-painter/renderParagraph.ts` — replace
  `renderFieldRun`'s switch with `evaluateField`.
- `packages/folio/src/core/layout-engine/measure/measureParagraph.ts` — measure
  the evaluated value (from current-best context) instead of raw `fallback`.
- Stage 2: `core/utils/headingCollector.ts` + a TOC builder
  (`core/layout-engine/fields/toc.ts`) consuming the page map; emit real PM
  paragraphs (TOC entry styles, leader tabs, PAGEREF); wire into the
  iterate-to-stable loop; update `ParagraphExtension` `generateTOC`.
- Serialize: `packages/folio/src/core/docx/serializer/runSerializer.ts` /
  `@stll/docx-core` — write computed result text into the cached run, keep
  `instruction` + `fldChar` round-trip, set `dirty`.

No DB schema, API, or auth changes (folio is client-side). No security/ethical-
wall surface; all changes are within the editor's layout pipeline.

## Test Cases

- Evaluator units (pure): PAGE/NUMPAGES/SECTIONPAGES with arabic/ROMAN/alpha
  switches; SEQ increments and `\c`/`\r` reset basics; PAGEREF/REF resolve a
  bookmark to its page; DATE `\@` formats.
- Golden layout (deterministic harness): a multi-page doc with PAGE/NUMPAGES in
  a footer and a PAGEREF/SEQ in the body -> assert each field's painted value
  and that the field's measured width matches the painted value (no skew).
- Iterate-to-stable: a doc where the live page-number width pushes content to an
  extra page -> loop converges and final values are self-consistent (cap not
  exceeded).
- Round-trip: parse -> evaluate -> serialize keeps `instruction`, updates cached
  result, and re-parses cleanly (extend `corpusRoundtrip`/property tests).
- Stage 2 TOC: headings at levels 1-3 -> generated TOC entries (real PM
  paragraphs) map to the correct pages with right-aligned leaders; the entries
  round-trip to DOCX; regeneration after an edit that shifts a heading updates
  the page number.

## Resolved Decisions

- **Evaluator home**: folio-local (`core/layout-engine/fields/`); promote to
  `@stll/docx-core` later only if a headless/server renderer needs it.
- **Phasing**: one PR, foundation then TOC (build order, not separate PRs).
- **TOC form**: real PM/doc content (editable, round-trips), not a layout-only
  synthetic block.
- **To tune during build** (not blockers): iterate-to-stable cap (start 3) and
  the width-change threshold (start: any integer-width change re-measures just
  that paragraph); calibrate against the corpus.
