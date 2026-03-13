# Plan: Local Anonymisation Pipeline (retroactive)

Date: 2026-03-13
Status: Implemented

## Goal

Detect and redact PII in legal documents entirely client-side,
with no data leaving the browser. The pipeline combines
deterministic layers (trigger phrases, regex, gazetteer) with
ML-based NER (GLiNER via ONNX) to catch both structured PII
(IBANs, birth numbers, emails) and unstructured PII (names,
addresses, organisations) across Czech, German, English, and
Slovak legal documents.

The output is a redacted plaintext with stable, numbered
placeholders (`[PERSON_1]`, `[COMPANY_2]`) and a reversible
redaction key for authorised de-anonymisation.

## Design Decisions

- **Client-side only; zero server contact.** Attorney-client
  privilege means PII must never hit the server during
  anonymisation. The entire pipeline (including NER inference)
  runs in the browser. The GLiNER model runs in a Web Worker
  via ONNX Runtime (WebGPU preferred, WASM fallback). Models
  are cached in the browser's Cache API after first download.

- **Multi-layer detection over single-model reliance.** A
  single NER model misses structured patterns (IBANs, birth
  numbers) and language-specific triggers (Czech "r.č.:",
  German "Steuernummer:"). Conversely, regex alone cannot
  catch free-form names. The pipeline stacks five independent
  detection layers, each contributing Entity spans with
  confidence scores, then merges and deduplicates:

  1. **Trigger phrases** — domain-specific prefixes from JSON
     configs (Czech: 21 rules, German: 16 rules). Score: 0.95.
  2. **Regex patterns** — structured formats (IBAN, email,
     phone, credit card, dates, IPs, titled persons with
     Czech/German academic titles). Score: 1.0 (deterministic).
  3. **Gazetteer** — workspace-scoped deny list in IndexedDB.
     Aho-Corasick exact match (score 1.0) + Levenshtein fuzzy
     match for missing diacritics/typos (score 0.85–0.9).
  4. **GLiNER NER** — ONNX model in Web Worker. Chunked
     inference (1500-char overlapping chunks) to fit the 512-
     token context window. Score: model confidence.
  5. **Coreference** — extracts defined-term aliases
     ("hereinafter the Seller") near detected entities, then
     re-scans the full text for alias occurrences. Score: 0.95.

- **Confidence boosting for near-miss entities.** NER entities
  scoring just below the threshold (within 0.15) get +0.05
  per high-confidence neighbour within 150 chars. This promotes
  entities that the model is unsure about but that appear in
  PII-dense regions.

- **False-positive filtering as a post-processing step.** After
  merging all layers, a filter removes template placeholders,
  section/clause numbers, standalone years, and generic legal
  role terms (in Czech, German, English). This avoids cluttering
  review with non-PII detections.

- **Stable, normalised placeholder mapping.** Surface-form
  variations of the same entity ("Dr.  Müller" vs "Dr. Müller",
  "+420 123 456 789" vs "+420123456789") map to the same
  placeholder via label-aware normalisation (emails lowercased,
  phones stripped, IBANs uppercased, names collapsed). First
  occurrence in document order determines the placeholder
  number.

- **Human review before redaction.** The pipeline produces
  candidates; the user confirms, rejects, or relabels each
  entity before redaction. A "review mode" highlights low-
  confidence entities for focused attention. Confirmed entities
  can be added to the workspace gazetteer for future documents.

- **Trigger rules as JSON configs, not code.** Czech and German
  trigger phrases live in `config/triggers.cs.json` and
  `config/triggers.de.json`. Each rule specifies a trigger
  string, entity label, and extraction strategy (`to-next-comma`,
  `to-end-of-line`, `n-words`). Adding a new trigger requires
  no code change; just add a JSON entry.

- **Chunker for bounded inference.** GLiNER's context window is
  ~512 tokens. The chunker splits text into 1500-char segments
  (rough 4:1 char/token ratio) with 50-char overlap, breaking
  at sentence boundaries when possible. Chunk-level entity
  offsets are mapped back to document-level offsets, and
  duplicates in overlap regions are deduplicated (keep highest
  score).

## Scope

**In scope (implemented):**

- 8-step detection pipeline (trigger → regex → gazetteer →
  NER → boost → merge/filter → coreference → rescan)
- Czech and German legal trigger phrases (JSON configs)
- Regex patterns for IBAN, email, phone, credit card, birth
  number, dates (numeric, spaced, written-out in Czech/German),
  IP addresses, titled persons (Czech/German academic titles
  with post-nominals)
- IndexedDB-backed workspace gazetteer with Aho-Corasick exact
  and Levenshtein fuzzy matching
- Coreference extraction for Czech, German, English, Slovak
  defined-term patterns
- Confidence boosting for near-miss NER entities
- False-positive filtering (placeholders, section numbers,
  years, generic roles in cs/de/en)
- Stable placeholder redaction with normalised co-reference
- Reversible redaction key (JSON export)
- De-anonymisation function
- GLiNER Web Worker with WebGPU/WASM backend detection,
  model caching, download progress reporting
- Text chunking with overlap deduplication
- Dev UI with model selector, file upload (DOCX), paste input,
  label toggles, threshold slider, review mode, annotated text
  view, entity sidebar, redacted output

**Out of scope (not implemented):**

- PDF file support (see plan 020)
- Server-side anonymisation
- Batch processing
- Image-based documents (OCR)
- Production UI integration (currently dev route only)
- Gazetteer management UI (currently add-only via review)
- Custom trigger rule editor
- English/Slovak trigger phrase configs (only cs/de exist)
- Metadata stripping (author, comments, tracked changes)

## Implementation

### Module structure

```
apps/web/src/lib/anonymize/
├── types.ts              # Core types, model options, labels, colors
├── pipeline.ts           # 8-step orchestrator, mergeAndDedup
├── trigger-phrases.ts    # JSON-driven trigger phrase scanner
├── regex-patterns.ts     # Regex PII patterns (titled persons, IBAN, etc.)
├── gazetteer.ts          # IndexedDB store + Aho-Corasick/Levenshtein scan
├── coreference.ts        # Defined-term alias extraction + rescan
├── confidence-boost.ts   # Near-miss entity promotion
├── false-positive-filter.ts  # Post-merge false positive removal
├── redact.ts             # Placeholder mapping, redaction, de-anonymisation
├── chunker.ts            # Text splitting + chunk entity merging
├── levenshtein.ts        # Edit distance for fuzzy gazetteer
├── config/
│   ├── triggers.cs.json  # Czech trigger phrases (21 rules)
│   └── triggers.de.json  # German trigger phrases (16 rules)
├── __fixtures__/
│   ├── czech-purchase-agreement.txt
│   └── german-lease-agreement.txt
└── __snapshots__/
    └── pipeline.test.ts.snap
```

### Dev UI

```
apps/web/src/routes/_protected.dev/
├── anonymize.tsx         # Main dev page
└── -gliner-worker.ts     # Web Worker for ONNX inference
```

### Dependencies

- `@monyone/aho-corasick` — Aho-Corasick automaton for gazetteer
- `idb` — IndexedDB wrapper for gazetteer persistence
- `mammoth` — DOCX text extraction
- `nanoid` — Gazetteer entry IDs
- GLiNER ONNX models (downloaded at runtime, cached in Cache API):
  - `gliner_multi_pii-v1` fp16 (580 MB) and int8 (349 MB)
  - `gliner_multi-v2.1` fp16 (580 MB) and int8 (349 MB)
  - `gliner-pii-edge-v1.0` fp16 (91 MB)

### Data flow

```
DOCX upload
  → mammoth.extractRawText() → plaintext
  → pipeline.runPipeline(plaintext, config, gazetteer, nerInference)
    → Step 1: detectTriggerPhrases(text) → Entity[]
    → Step 2: detectRegexPii(text) → Entity[]
    → Step 3: scanExact(text, entries) + scanFuzzy(...) → Entity[]
    → Step 4: nerInference(text, labels, threshold) → Entity[]
       ↳ chunker splits text → Web Worker runs GLiNER per chunk
       ↳ mergeChunkEntities() deduplicates overlap
    → Step 5: boostNearMissEntities(all, threshold) → Entity[]
    → Step 6: mergeAndDedup() → filterFalsePositives() → Entity[]
    → Step 7: extractDefinedTerms(text, entities) → DefinedTerm[]
    → Step 8: findCoreferenceSpans(text, terms) → Entity[]
       ↳ mergeAndDedup(merged, corefSpans)
  → User reviews entities (confirm/reject/relabel)
  → redactText(text, confirmedEntities) → RedactionResult
    → { redactedText, redactionMap, entityCount }
```

## Test Cases (131 tests, all passing)

| Suite | Tests | Covers |
|---|---|---|
| `pipeline.test.ts` | 29 | End-to-end pipeline, merge/dedup, config flags |
| `regex-patterns.test.ts` | 24 | All regex patterns, edge cases, titled persons |
| `trigger-phrases.test.ts` | 18 | Czech/German triggers, extraction strategies |
| `redact.test.ts` | 13 | Placeholder mapping, normalisation, de-anonymisation |
| `false-positive-filter.test.ts` | 12 | All filter categories |
| `chunker.test.ts` | 10 | Splitting, offsets, chunk entity merging |
| `levenshtein.test.ts` | 10 | Edit distance correctness |
| `coreference.test.ts` | 9 | Defined terms, alias scanning, multilingual |
| `confidence-boost.test.ts` | 6 | Near-miss promotion, no-op cases |

Snapshot tests cover full pipeline output on Czech and German
fixture documents.
