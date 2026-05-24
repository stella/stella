# Plan: Folio Canonical Document Model

Date: 2026-05-24

## Goal

Make `@stll/docx-core/model` the canonical document contract for Folio so
DOCX import, ProseMirror editing, layout, save, and export all pass through one
typed and validated representation. The goal is to reduce document-corruption
risk while keeping the editor maintainable for a single maintainer.

## Design Decisions

- **Use the existing docx-core model, not a new parallel model.** The model in
  `packages/docx-core/src/model/*` already defines documents, paragraphs, runs,
  tables, comments, sections, relationships, media, styles, and numbering. The
  project needs stricter ownership of that model, not another abstraction.
- **Treat ProseMirror as an adapter, not the source of truth.** ProseMirror
  nodes and attrs are an editing format. Semantic document state should enter
  and leave through typed adapter functions instead of raw `node.attrs` and
  `mark.attrs` casts spread across conversion, layout, and components.
- **Keep preservation data explicit.** Unsupported Word/OOXML data can be
  preserved opaquely, but it should live in named preservation fields with
  invariants rather than accidental plumbing through editor attrs.
- **Validate before save/export.** Saving a legal document should fail loudly if
  the canonical model is structurally invalid: broken comments, missing media
  relationships, invalid table shape, orphaned numbering, duplicate IDs, or
  section/header/footer loss.
- **Ship as one PR with reviewable commits.** The PR should progress from
  planning, to validation, to typed boundaries, to parse/save integration, so
  reviewers can assess each layer independently.

## Scope

**In scope:**

- Canonical model ownership around `@stll/docx-core/model`
- Runtime validation/invariant checks for the document model
- Typed ProseMirror attr readers and writers
- Conversion boundary cleanup: DOCX to model to PM to model to DOCX
- Save/export safety gates
- Roundtrip and fixture tests for legal-document structures
- Reducing broad Folio lint/type relaxations where adapter boundaries make them
  unnecessary

**Out of scope:**

- Replacing ProseMirror
- Rewriting the OOXML parser or serializer from scratch
- Real-time collaboration changes
- Major UI redesign
- Perfect preservation of every obscure OOXML feature in the first pass

## Implementation

- `packages/docx-core/src/model/*` — keep these as the canonical semantic model.
  Clarify semantic fields versus preservation payload only where needed.
- `packages/docx-core/src/validate/docx.ts` — expand validation beyond package
  shape into canonical model invariants: comments, media, relationships,
  numbering, sections, tables, tracked changes, and IDs.
- `packages/folio/src/core/prosemirror/attrs/` — add typed attr readers/writers,
  for example `readParagraphAttrs(node)`, `readTableAttrs(node)`, and
  `readRunMarkAttrs(mark)`. This becomes the approved place to touch raw
  `node.attrs` and `mark.attrs`.
- `packages/folio/src/core/prosemirror/conversion/toProseDoc.ts` — use typed
  attr writers when converting canonical model objects into PM nodes.
- `packages/folio/src/core/prosemirror/conversion/fromProseDoc.ts` — replace
  direct casts such as `node.attrs as ParagraphAttrs` with typed readers and
  validation/narrowing.
- `packages/folio/src/core/layout-bridge/toFlowBlocks.ts` — stop reading raw PM
  attrs directly where possible. Consume typed projection helpers so layout
  depends on a stable shape.
- `packages/folio/src/core/docx/parser.ts` — after parsing, run canonical-model
  validation and return warnings/errors in a structured way.
- `packages/folio/src/core/docx/rezip.ts` and
  `packages/folio/src/core/docx/selectiveSave.ts` — run save/export invariants
  before patching or repacking. Keep existing fidelity checks, but make them
  part of a broader validation gate.
- `packages/folio/src/core/docx/__tests__/` — add fixture-oriented tests for
  comments, tracked changes, headers/footers, footnotes, numbering, tables,
  section breaks, images, and Czech/Slovak text.
- `oxlint.config.ts` — after adapter boundaries exist, tighten Folio overrides
  gradually. The goal is not zero casts everywhere; it is casts only at named
  adapter and FFI files.

## Test Cases

- DOCX parse produces a valid canonical model for existing fixtures.
- Model to PM to model preserves paragraphs, runs, tables, comments, tracked
  changes, sections, numbering, headers/footers, footnotes, and media
  relationships.
- Save fails before writing if validation finds broken relationships or
  structural corruption.
- Selective save cannot drop section properties or header/footer references.
- Unsupported OOXML preservation fields survive an edit when the user does not
  touch the related structure.
- Typed PM attr readers reject malformed attrs in unit tests.
- Property tests cover generated paragraphs, tables, marks, comments, and
  tracked changes.
- Fixture roundtrips assert semantic invariants rather than byte equality.

## Commit Stack

- `docs: plan folio canonical document model`
- `feat(docx-core): validate canonical document invariants`
- `feat(folio): add typed prosemirror attr boundaries`
- `fix(folio): validate parsed and saved documents`
- `refactor(folio): route conversion through typed attrs`

## Open Questions

- Should validation live entirely in `@stll/docx-core`, or should Folio own
  editor-specific invariants separately?
- What should the first legal DOCX corpus contain: synthetic fixtures,
  anonymized real documents, or both?
- Should save/export validation be blocking immediately, or warning-only for one
  migration phase?
- Should ProseMirror attr access be lint-enforced once typed readers exist?
