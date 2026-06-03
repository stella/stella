# Differential parser testing (folio vs python-docx)

This directory holds a small scaffold for cross-checking folio's DOCX
parser against an established reference parser. PR #587 (block-level
content controls) surfaced a handful of prefix / namespace / OnOff edge
cases where a spec-faithful implementation still disagreed with how
mature parsers actually interpret the wire format. Differential testing
catches that class of issue directly.

The scaffold is intentionally minimal: one orchestrator script, one
projection helper per side, one smoke test. Scaling to a fixture corpus,
property-based generators, or CI integration is a follow-up.

## Why python-docx (and not docx4j)

- **No JVM.** Runs in well under a second per small fixture; trivial to
  shell out from a Bun script.
- **Already on the dev image.** Python 3.x is preinstalled on macOS dev
  machines and most CI runners; the only extra step is
  `pip install python-docx`.
- **Wire-format-friendly API.** python-docx exposes the underlying
  `lxml` element tree (`document.element.body`), so the projector can
  count `w:p` / `w:r` / `w:tbl` / `w:sdt` directly against the OOXML
  XPath — closer to "what the file actually says" than the high-level
  `paragraphs`/`tables` API.

docx4j was considered as an alternative but it requires a JVM in CI and
a much larger install footprint. We can revisit it later if there is a
specific behaviour python-docx cannot model (e.g., advanced field
resolution).

## Setup

```bash
# One-time, on dev or CI image:
pip install --user python-docx
```

The smoke test (`packages/folio/src/core/docx/__tests__/differential.test.ts`)
auto-skips if `python3 -c "import docx"` fails, so contributors without
python-docx see a clean local test run rather than a hard failure.

## Running

Against a single DOCX:

```bash
bun packages/folio/scripts/differential/diff.ts path/to/file.docx
```

Exit codes:

- `0` — projections are equivalent.
- `1` — at least one structural divergence (printed to stderr).
- `2` — infrastructure error (python missing, fixture missing, parse
  exception).

The smoke test runs the same harness against
`__fixtures__/regressions/repack-paragraph-sectpr.docx` to prove the
wiring works end-to-end without committing the project to a full corpus
sweep.

## Projection shape

Both projectors emit the same normalised JSON shape (see
`StructuralProjection` in `projection.ts`):

- `totalParagraphs` — all `w:p` elements reachable from the body
  subtree, including paragraphs nested in tables and block SDTs.
- `totalTables` — all `w:tbl` elements reachable from the body subtree.
- `topLevelBlocks` — direct paragraph/table/SDT children of `w:body`.
- `sdts[]` — `{ scope, sdtType, alias?, tag?, lock?, childCount }` for
  each `w:sdt` in document order.
- `sdtCountsByType` — quick eyeball summary of the SDT inventory.

### What we do not project (and why)

- **Run count.** folio applies a run consolidator: adjacent
  identically-formatted `w:r` elements collapse into one. Wire-format
  run counts will therefore always diverge from python-docx on real
  documents. Adding `totalRuns` back would make every interesting
  fixture diverge for an uninteresting reason. If run-level parity
  becomes interesting, compare _consolidated_ runs on both sides
  instead of raw `w:r`.
- **Split inline SDT segments are coalesced.** Folio splits a wire
  `w:sdt` whose inline content straddles a lifted marker (bookmark /
  comment range / tracked-change boundary) into multiple `InlineSdt`
  segments that share one `SdtProperties` reference. The folio
  projector merges those segments back into a single entry (summing
  `childCount`) so it matches the python projector's one-entry-per-
  `w:sdt` view; otherwise every bookmarked or comment-marked control
  would diverge on `sdts` length for an uninteresting reason.
- **Textbox content.** folio models drawing-anchored paragraphs and
  tables as run-level shape content, not block content. The python
  projector excludes paragraphs/tables/SDTs inside `w:txbxContent` to
  keep the body-block comparison apples-to-apples. Textbox parity is
  tracked as a separate concern.

## Extending to a corpus

A future PR can scale this to a full corpus loop. Sketch:

1. Drop additional fixtures under
   `packages/folio/src/core/docx/__tests__/__fixtures__/differential/`.
2. Add a `differential-corpus.ts` script that globs the directory, runs
   `runDifferential` per file, accumulates results, and prints a
   summary.
3. Triage each new divergence: either fix folio, document it as an
   intentional shape difference (and filter in the projection), or
   record it as a known divergence with a tracking issue.
4. Decide whether to wire the corpus into CI. Start as opt-in / nightly
   — the harness is not meant to be a blocking signal until divergence
   triage is complete.

## What python-docx covers (and doesn't)

Covers cleanly:

- Block structure (`w:p`, `w:tbl`, `w:sdt`) at any depth.
- SDT properties recoverable from `w:sdtPr` (alias, tag, lock, type).
- Headers/footers/footnotes (via `doc.part.related_parts` — not used
  yet by this projection; would extend cleanly).

Does not cover:

- Run consolidation semantics (it preserves wire-format runs as-is).
- Anything below `w:r` (text content, breaks, tabs) without bespoke
  walking — fine for our needs, but would expand if we projected
  run-level content.
- Advanced field/complex-field resolution.
- Drawing/SmartArt internals.

## Files

- `projection.ts` — folio-side structural projection.
- `python_docx_project.py` — python-docx-side structural projection.
- `diff.ts` — orchestrator CLI; exported `runDifferential` is reused by
  the smoke test.
- `../../src/core/docx/__tests__/differential.test.ts` — single smoke
  test that proves the harness works on a known-good fixture.
