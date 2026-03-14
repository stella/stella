# Plan: PDF Anonymisation via Overlay

Date: 2026-03-13

## Goal

Produce an anonymised PDF that can be sent to AI for analysis
(review, extraction, etc.). The anonymised PDF is geometry-
identical to the original: same page sizes, same text positions,
same line breaks. The only difference is that PII spans are
replaced by white rectangles with placeholder text (`[PERSON_1]`,
`[COMPANY_2]`). This means any bounding boxes the AI draws on the
anonymised PDF are valid coordinates on the original PDF too,
so we can render AI annotations on the original without
recalculation.

A redaction map (`[PERSON_1] ↔ Pavel Novák`) is persisted
alongside the anonymised PDF. When the AI responds with
placeholder references ("PERSON_1 is the buyer"), the UI
resolves them back to real names for the user.

Everything runs client-side; no PII leaves the browser.

## Design Decisions

- **Geometry-preserving overlay.** The anonymised PDF must be a
  pixel-perfect copy of the original except for the redacted
  text spans. No text reflow, no layout changes, no page-size
  differences. This is what makes AI bounding boxes transferable
  between the two versions. White rectangle + placeholder text
  drawn on top of the original content at the exact same
  coordinates achieves this.

- **White-box overlay, not content-stream rewrite.** True text
  replacement in PDF content streams is fragile (font subsetting,
  glyph positioning, fragmented operators). Instead: white
  rectangle + placeholder text on top, then neutralise the
  original text operators at those positions. This is what
  Adobe Acrobat's redaction tool does internally.

- **Client-side only.** The anonymisation pipeline already runs
  entirely in the browser (ONNX/WebGPU NER in a Web Worker,
  regex/trigger/gazetteer on the main thread). PDF manipulation
  must stay client-side too: no PII hits the server. `@libpdf/core`
  has no Node.js dependencies and works in the browser.

- **pdfjs-dist for coordinate mapping, @libpdf/core for mutation.**
  pdfjs-dist provides `getTextContent()` which returns `TextItem`
  objects with transform matrices (exact glyph positions). We use
  this to build a character-offset → page-coordinate map. Then
  @libpdf/core draws the overlays and removes the original text
  operators. Two libraries, each doing what it's best at.

- **Content-stream text removal for security.** Drawing a white
  box is not enough; the original text remains in the PDF stream
  and can be extracted by copy-paste or programmatic tools. We
  must parse the content stream (`ContentStreamParser`), identify
  text operators (`Tj`, `TJ`, `'`, `"`) whose positions overlap
  with redacted regions, remove or replace them, and re-serialize
  (`ContentStreamSerializer`). This is the hardest part but
  non-negotiable for legal data.

- **Redaction map as a first-class artifact.** The map is not
  just for export; it's the bridge between AI outputs and the
  user's view. It must be structured, serialisable, and
  persistable (IndexedDB or passed to the backend alongside
  the anonymised PDF). The existing `redactText()` mapping
  from `redact.ts` already produces this; we reuse it.

- **Separate module, not inline in the dev UI.** The PDF
  anonymisation logic lives in `apps/web/src/lib/anonymize/pdf-redact.ts`
  (coordinate mapping, overlay drawing, content stream surgery).
  The dev UI just calls it and triggers a download.

## Scope

**In scope:**

- PDF file upload in the anonymisation dev UI (alongside DOCX)
- Text extraction from PDF via pdfjs-dist `getTextContent()`
- Character-offset → PDF-coordinate mapping (per page)
- White rectangle overlay at entity positions
- Placeholder text overlay in Helvetica at entity positions
- Content stream text removal under redacted regions
- Geometry preservation (no layout changes between original
  and anonymised)
- Download of the anonymised PDF
- Redaction map export (JSON) and persistence for AI response
  resolution
- User preview of the anonymised PDF (so they know what the
  AI will see)

**Out of scope:**

- PDF form fields (XFA/AcroForm) — text in form fields is not
  redacted in v1
- Image-based PDFs (scanned documents) — requires OCR, separate
  feature
- Batch processing (multiple PDFs) — single file for now
- Server-side PDF anonymisation endpoint
- AI bbox rendering on the original PDF (consumer of the
  coordinate system, not part of anonymisation itself)
- Annotations, comments, metadata stripping — future hardening
- De-anonymisation (reconstructing the original PDF from the
  anonymised one + map); the original is simply kept

## Implementation

### Phase 1: Text coordinate mapping

`apps/web/src/lib/anonymize/pdf-coords.ts`

Build a mapping from character offsets (as produced by the
pipeline's plaintext extraction) to PDF page coordinates.

- Load PDF with pdfjs-dist `getDocument()`
- For each page, call `page.getTextContent()` to get `TextItem[]`
- Each `TextItem` has: `str` (text), `transform` (6-element
  matrix with x, y), `width`, `height`
- Concatenate all `TextItem.str` values with appropriate
  separators to reconstruct the plaintext (must match what the
  pipeline received)
- Build an index: for each character offset in the concatenated
  text, store `{ pageIndex, x, y, width, height }` derived from
  the corresponding `TextItem`'s transform
- The concatenated text is what gets fed to the anonymisation
  pipeline, ensuring offset consistency

The coordinate map is the contract that makes AI bboxes
transferable. Both the anonymised and original PDFs share
the same coordinate space because we only overlay content;
we never move, reflow, or resize anything.

### Phase 2: PDF overlay drawing

`apps/web/src/lib/anonymize/pdf-redact.ts`

Given the coordinate map and confirmed entities:

- Load the same PDF with `@libpdf/core`'s `PDF.load()`
- For each entity, look up its page coordinates from the map
- Draw a white filled rectangle covering the entity's bounding
  box (with small padding)
- Draw the placeholder text (from `redactText()` mapping) in
  Helvetica at the same position, using the original text's
  font size from the TextItem metadata
- Handle multi-line entities (entity spans multiple `TextItem`s
  across lines → multiple rectangles per entity, single
  placeholder label on the first line)
- Return the modified PDF as `Uint8Array` plus the redaction
  map

Critical: no operations may change page dimensions, margins,
or the position of any non-redacted content. The overlay is
purely additive (draw on top) + subtractive (remove text
underneath).

### Phase 3: Content stream neutralisation

Extension of `pdf-redact.ts`.

For each page that has redacted entities:

- Parse the page's content stream with `ContentStreamParser`
- Walk the operator list, tracking the current text matrix
  (BT/ET blocks, Td/Tm operators)
- For each text operator (`Tj`, `TJ`, `'`, `"`), check whether
  its position overlaps any redacted region on that page
- If it overlaps: replace the text operand with spaces (same
  byte length, preserving stream structure) or remove the
  operator entirely
- Re-serialize with `ContentStreamSerializer` and replace the
  page's content stream

This is the security-critical step. Without it, the original
text is extractable from the PDF despite the white overlay.

### Phase 4: Redaction map persistence

`apps/web/src/lib/anonymize/redaction-map.ts`

The redaction map needs to survive beyond the anonymisation
session so that AI responses referencing placeholders can be
resolved later.

- Serialise as JSON: `{ "[PERSON_1]": "Pavel Novák", ... }`
- Store alongside the anonymised PDF (IndexedDB keyed by
  document ID, or as a sidecar file)
- Provide a resolution function: given AI text containing
  placeholders, replace all occurrences with originals
- Provide the inverse: given user text with real names,
  replace with placeholders (for sending follow-up queries
  to AI)

The existing `redactText()` and `deanonymise()` in `redact.ts`
already handle the text replacement logic. This phase adds
persistence and a lookup API.

### Phase 5: Dev UI integration

`apps/web/src/routes/_protected.dev/anonymize.tsx`

- Accept `.pdf` in the file upload input (alongside `.docx`,
  `.txt`)
- When a PDF is uploaded: extract text via pdfjs-dist
  `getTextContent()`, build the coordinate map, feed text to
  the pipeline
- Store the original PDF `ArrayBuffer` and coordinate map in
  component state
- After redaction: call `pdf-redact.ts` to produce the
  anonymised PDF as `Uint8Array`
- Add a "Preview Anonymised PDF" toggle so the user can see
  what the AI will receive
- Add a "Download Anonymised PDF" button
- Show the redaction map in a collapsible panel
  (placeholder ↔ original, two columns)

### File summary

| File                                               | Change                                          |
| -------------------------------------------------- | ----------------------------------------------- |
| `apps/web/src/lib/anonymize/pdf-coords.ts`         | New: coordinate mapping                         |
| `apps/web/src/lib/anonymize/pdf-redact.ts`         | New: overlay + content stream surgery           |
| `apps/web/src/lib/anonymize/redaction-map.ts`      | New: map persistence + resolution API           |
| `apps/web/src/lib/anonymize/pdf-coords.test.ts`    | New: tests                                      |
| `apps/web/src/lib/anonymize/pdf-redact.test.ts`    | New: tests                                      |
| `apps/web/src/routes/_protected.dev/anonymize.tsx` | Modified: PDF upload, preview, download         |
| `apps/web/package.json`                            | Add `@libpdf/core` (already in api, add to web) |

No DB schema changes. No backend changes.

## Test Cases

- **Geometry preservation**: original and anonymised PDFs have
  identical page count, page dimensions, and non-redacted text
  positions
- **Coordinate mapping accuracy**: extract text + coords from a
  known PDF, verify that character offsets map to correct page
  positions
- **Placeholder text rendering**: placeholder text is readable
  in the output PDF (correct font, size, position)
- **Content stream neutralisation**: after redaction, extracting
  text from the output PDF (via pdfjs-dist) should yield
  placeholders, not original PII
- **Bbox transferability**: draw a rectangle at coordinates
  (x, y, w, h) on the anonymised PDF; the same rectangle on
  the original PDF covers the same visual region
- **Redaction map round-trip**: map serialises to JSON and
  deserialises correctly; `deanonymise()` restores placeholder
  references in AI output
- **Multi-page entity**: entity near a page break maps to
  correct page
- **Empty/no-entity case**: PDF with no detected entities
  produces an unchanged output

## Open Questions

- **Text extraction consistency**: pdfjs-dist's `getTextContent()`
  may produce slightly different text ordering than reading order
  (e.g., multi-column layouts, headers/footers). Should we add a
  normalisation pass, or accept that edge cases in complex layouts
  may misalign? Start with simple single-column documents and
  expand.

- **Content stream access in @libpdf/core**: the library has
  `ContentStreamParser` and `ContentStreamSerializer` internally.
  Need to verify these are part of the public API or accessible
  without hacks. If not, alternative: flatten each redacted page
  to an image (canvas render → re-embed as image page). Secure
  but lossy (and would break geometry preservation for vector
  content).

- **Font sizing for placeholders**: placeholder text like
  `[PERSON_1]` may be wider or narrower than the original text.
  Should we scale the font to fit the original bounding box, use
  a fixed small size, or let it overflow? Proposal: use the
  original text's font size (from TextItem metadata) and accept
  minor width differences. The white rectangle covers the
  original regardless.

- **Redaction map storage location**: IndexedDB (client-side,
  ephemeral) vs. backend (persistent, tied to document record)?
  For the dev UI, IndexedDB is fine. For production, the map
  likely needs to be stored server-side (encrypted) alongside
  the document, with access control.
