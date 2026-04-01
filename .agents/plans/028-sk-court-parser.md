# Plan: Slovak Court Decision Parser

Date: 2026-04-01

## Goal

Build a parser for Slovak court decisions (obcan.justice.sk) that
converts PDF-extracted plaintext into a canonical DocumentAst with
headings, paragraphs, roles, and inline formatting. Also fix the
adapter to save sourceRaw and integrate the parser.

## Design Decisions

- **PDF plaintext is the only source.** The SK API serves decisions
  exclusively as PDFs; no HTML/RTF/XML alternative exists. The
  `unpdf` library extracts well-structured plaintext with consistent
  patterns (header block, spaced-out section markers, numbered
  paragraphs). This is similar to the CZ-ÚS RTF parser approach.

- **Line-based parsing, not heuristic splitting.** SK PDF text
  preserves line breaks between sections. We split on double
  newlines to get paragraphs, then classify each paragraph by
  regex patterns. Per CLAUDE.md rule #4, we rely on the structural
  patterns the court uses (spaced-out markers like
  `r o z h o d o l :`, numbered paragraphs `1.`, `2.`) rather
  than inventing heuristics.

- **Spaced-out text is a feature, not a bug.** Slovak courts use
  letter-spaced formatting for emphasis: `r o z h o d o l`,
  `o d ô v o d n e n i e`, `t e d a`, `j e v i n n á`. The parser
  normalizes these for `plainText` but preserves them as bold
  inlines for display fidelity.

- **sourceRaw saves both list JSON and detail JSON.** Per CLAUDE.md
  rule #3, the adapter must save the raw API responses. We store
  `JSON.stringify({ listItem, detail })` so future re-parsing
  doesn't require re-downloading.

## Scope

**In scope:**

- `parsers/sk-courts.ts` — new parser module
- `parsers/sk-courts.test.ts` — tests with real PDF fixtures
- `adapters/sk-courts.ts` — fix sourceRaw, integrate parser
- Enable SK in production (remove from DISABLED_ADAPTERS)

**Out of scope:**

- Citation extraction from SK text (separate feature)
- Anonymization detection (SK courts anonymize via XX patterns
  in the PDF itself; no markup to preserve)
- Full historical backfill cursor strategy (SK uses page-based
  DESC pagination which is already safe)

## Implementation

### Parser: `parsers/sk-courts.ts`

Input: PDF plaintext string + metadata from adapter.
Output: `{ documentAst: DocumentAst, fulltext: string }`.

**Section detection patterns (Slovak):**

| Section | Pattern | Role |
|---------|---------|------|
| Header metadata | `Súd:`, `Spisová značka:`, `ECLI:` lines | (skipped, metadata from API) |
| Decision title | `Uznesenie`, `Rozsudok`, `Trestný rozkaz` on its own line | heading level 1 |
| Intro | Court name + composition + "v ... veci" | `"intro"` paragraph |
| Holding marker | `r o z h o d o l :` or `rozhodol:` | heading level 2 |
| Holding items | Roman numerals (I., II.) or continuous ruling | `"holding"` paragraphs |
| Reasoning marker | `o d ô v o d n e n i e :` or `Odôvodnenie:` | heading level 2 |
| Reasoning items | Numbered paragraphs (1., 2., 3.) | regular paragraphs |
| Closing | `V {City} dňa ...` | `"closing"` paragraph |
| Signature | Title prefixes (JUDr., Mgr., doc.) | `"signature"` paragraph |
| Poučenie | `P o u č e n i e :` or `Poučenie:` | heading level 2 |

**Spaced-text normalization:**

`r o z h o d o l` → `rozhodol` (collapse single-char spacing for
plainText; keep original in bold inline for display).

### Adapter fixes: `adapters/sk-courts.ts`

- Save `sourceRaw: JSON.stringify({ listItem: item, detail })`
- Call `parseSkDecisionText()` when fulltext is available
- Store resulting `documentAst` instead of empty `{}`

### Test fixtures

- Record 3 real PDFs (uznesenie, rozsudok, trestný rozkaz)
- Extract text, save as `.txt` fixtures
- Test section classification, content retention >90%

## Test Cases

- Header metadata lines excluded from body blocks
- Decision title detected and classified as heading
- Spaced-out markers (`r o z h o d o l :`) detected as section
  headings
- Holding paragraphs (Roman numerals after holding marker) get
  `role: "holding"`
- Numbered reasoning paragraphs parsed correctly
- Closing formula and signature detected
- Content retention ≥90% via validateAndLog
- Empty/short PDFs handled gracefully (return empty AST)
- Parser is pure function (no I/O)

### Pipeline: spaced-letter normalization

Add a `collapseSpacedLetters()` step to `pipeline.ts`
`sanitizeResult()`, applied to all `fulltext` and `plainText`
fields across all adapters. Pattern: sequences of single
characters separated by spaces (`r o z h o d o l`) get collapsed
to the word (`rozhodol`). This improves search indexing for all
courts that use letter-spacing for emphasis (SK, possibly CZ).

Applied after `DANGEROUS_CHARS` strip, before DB insertion.
