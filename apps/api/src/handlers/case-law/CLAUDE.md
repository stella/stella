# Case Law Ingestion — Engineering Guide

## Architecture

```
Court website/API
  → Adapter (fetch + extract metadata)
    → Parser (HTML/JSON/RTF → DocumentAst)
      → Pipeline (sanitize, dedup, store, index)
```

- **Adapter**: fetches pages, extracts metadata, calls the parser,
  returns `IngestionResult[]`.
- **Parser**: transforms raw HTML/JSON/RTF into a canonical
  `DocumentAst` (headings, paragraphs, tables with inline
  formatting). Parsers are pure functions; adapters own I/O.
- **Pipeline**: sanitizes dangerous chars, deduplicates by
  `sourceHash`, upserts into `case_law_decisions`, extracts
  citations, indexes for full-text search.

## Hard Rules

These rules exist because we learned them the hard way. Follow
them for every new adapter/parser.

### 1. Always prefer the richest source

Courts often expose multiple endpoints for the same decision.
**Always** investigate all available endpoints and pick the one
with the richest structure:

| Court       | Bad source                                | Good source                                                            | Why                                            |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| CZ-NSS      | `/Text/{id}` (UTF-16LE plain)             | `/DokumentOriginal/Html/{id}` (Aspose HTML)                            | HTML preserves paragraphs, bold, headings      |
| CZ-ÚS       | `DocContent` table cell (crammed HTML)    | `docContentHidden` hidden field (RTF)                                  | RTF has `\par` paragraph breaks; HTML has none |
| CZ-Regional | `verdictText`/`justificationText` (plain) | `header[]`/`verdict[]`/`justification[]` (structured JSON with styles) | JSON preserves anonymization spans             |
| PL-SAOS     | `/api/search/judgments` list items        | `/api/dump/judgments` + `/api/judgments/{id}`                          | Detail API has rich HTML, citations, metadata  |

Before writing a new adapter, spend time exploring the court's
website. Check hidden fields, print views, API variants,
alternative export formats. The 30 minutes you spend now saves
hours of parsing heuristics later.

**How to find the richest source:**

1. **Open Chrome DevTools → Network tab**, load the court's
   search page, execute a search, and watch the XHR/Fetch
   requests. Most "modern" court sites are SPAs (React,
   Angular, Liferay portlets) that fetch data from a JSON
   API behind the scenes. The Network tab reveals the real
   endpoints, query params, and response shapes.
2. **Check for existing open-source scrapers.** Search GitHub
   for `site:github.com "{court-domain}"` or the court's
   API base URL. Academic NLP projects, legal-tech startups,
   and open-data initiatives often have working scrapers
   with documented endpoints. Use them as a reference, not
   a dependency.
3. **Probe common API patterns.** Many court sites are
   Liferay, ASP.NET, or WordPress-based. Try:
   - `/api/jsonws` (Liferay JSON-WS)
   - `?page=1&size=25&format=json` (REST pagination)
   - Hidden `<input type="hidden">` fields with data
   - Print/export views (`?format=pdf`, `?print=true`)
   - RSS/Atom feeds for recent decisions
4. **Check PDF structure with `@libpdf/core`.** If the court
   only serves PDFs, use `page.extractText()` which gives
   per-line text with font name (bold detection) and font
   size (title detection). This is far richer than `unpdf`'s
   merged plaintext. Always extract without `mergePages` to
   preserve line breaks.
5. **Test multiple decision types.** A Rozsudok (judgment)
   often has different structure than an Uznesenie
   (resolution) or Trestný rozkaz (criminal order). Download
   at least 3 different types before designing the parser.

**Important: a single decision may require multiple endpoints.**
The full picture of a case often lives across separate pages.
For example, CZ-ÚS has `GetText.aspx` (decision body) and
`GetAbstract.aspx` (abstract + legal sentence) as separate
endpoints. Neither is complete alone. Investigate every
available endpoint for each court and join the data in the
adapter. This applies to all countries; always check whether
detail pages, metadata endpoints, or abstract/summary pages
exist alongside the main decision text.

### 2. Save ALL available metadata

Every field the court API exposes must be forwarded to
`IngestionResult.metadata`. Even if we don't display it today,
it costs nothing to store and is impossible to recover later
without re-downloading.

Checklist for every adapter:

- [ ] Date, type, ECLI, court name
- [ ] Judge / reporting judge / senate
- [ ] Keywords, legal areas, statutes
- [ ] Case status, outcome, parties
- [ ] Popular name, parallel citations
- [ ] Publication date, category
- [ ] Any court-specific fields

Top-level `IngestionResult` fields (`ecli`, `decisionDate`,
`decisionType`) should ALSO be included in `metadata` for
completeness — the top-level fields drive display; metadata
is the archive.

### 3. Always save sourceRaw

`IngestionResult.sourceRaw` stores the verbatim response from
the court. This enables re-parsing without re-downloading.

- For HTML sources: store the raw HTML string
- For JSON APIs: `JSON.stringify(response)`
- For multiple pages: `JSON.stringify({ page1, page2 })`
- Never omit this. Future parser improvements are free if
  sourceRaw is saved; without it, you must re-download from
  a court that may have changed URLs, rate limits, or format.

### 4. No heuristics where structure exists

If the source gives you structure (HTML tags, JSON sections,
RTF markers), use it. Do not write regex-based heuristics to
split or classify text when the source already provides the
answer. Heuristics are:

- Fragile (break on edge cases)
- Hard to test (combinatorial)
- Hard to debug (silent failures)

Examples of heuristics we removed:

- `splitCrammedChunks` — tried to split single-paragraph HTML
  at sentence boundaries. Replaced by using the RTF source
  which has real paragraph breaks.
- `RULING_ITEM_RE` — tried to detect Roman numeral ruling
  items via regex. Replaced by just marking holding paragraphs
  with `role: "holding"` and keeping the full text.

### 5. Sanitize at the pipeline level

Individual adapters should NOT sanitize. The pipeline applies
`DANGEROUS_CHARS` (null bytes, BOM, C0 controls, zero-width
chars) to ALL fields including `sourceRaw`. This ensures
consistency and prevents PostgreSQL text column rejections.

### 6. Validate every parser with validateAndLog

Every parser MUST call `validateAndLog()` after producing
blocks. The validator checks:

- Content retention (>90% of source text preserved)
- Missing meaningful words (<15 allowed)
- Structural integrity (at least one heading, no empty AST)
- Inline/plainText consistency
- Duplicate and tiny block detection

If the validator flags content loss, investigate the source
— you're probably using the wrong endpoint or missing a
section. Don't suppress the warning.

### 7. Anonymization must be preserved

Some courts redact personal data (names, addresses). If the
source marks anonymized spans (e.g., Regional court's
`anonStyle: "ANON"`), preserve this as `anonymized: true` on
the `InlineText` node. The frontend renders these in brackets
with muted styling. Never silently drop anonymization markers.

### 8. Decision types must be in the local language

`decisionType` values must be stored in the court's own
language, lowercased. If the API returns English enums or
internal codes, map them to the local term before storing.

Any lookup map that keys on `decisionType` (e.g., `titleMap`
for synthesized headings) must use the same local-language
keys. A real P1 bug occurred when `titleMap` used English
keys (`judgement`, `resolution`) but `decisionType` had
already been mapped to Czech (`rozsudek`, `usnesení`);
the lookup always missed.

Examples per country:

- CZ: `rozsudek`, `usnesení`, `nález`, `příkaz`
- SK: `rozsudok`, `uznesenie`
- PL: `wyrok`, `postanowienie`
- AT/DE: `Urteil`, `Beschluss`

### 9. Cursors must never cause full re-scans

After an adapter exhausts its range (reaches the oldest year
in a backward crawl, or the current date in a forward crawl),
the cursor must **park** at a position that only re-scans a
bounded recent window (e.g., current year). Never return
`null` from an exhausted sweep; `null` restarts the adapter
from scratch, causing an infinite re-scan loop where every
previously ingested decision is re-fetched, hash-checked,
and skipped, consuming the page budget with zero progress.

## DocumentAst Conventions

```typescript
type Block = HeadingBlock | ParagraphBlock | TableBlock;
```

- `heading` with `level: 1|2|3` for section titles
- `paragraph` with optional `role`:
  - `"case-number"` — the file reference (top of document)
  - `"holding"` — ruling/verdict paragraphs (bold in reader)
  - `"closing"` — closing formula
  - `"signature"` — judge signatures
  - (no role) — regular body text
- `table` with optional `role`:
  - `"related-proceedings"` — hidden in reader

Every block has: `id` (nanoid), `anchorId` (stable for deep
links), `plainText` (for search/AI), and typed inlines.

Inline types: `text` (with optional `anonymized`), `bold`,
`italic`, `link`, `line-break`.

## Adapter Checklist for New Countries

When adding a new country adapter:

1. **Explore the source** — find all available endpoints, check
   for rich HTML/JSON/XML variants, hidden fields, print views
2. **Write the adapter** — implement `SourceAdapter` interface
   with `fetchPage()` and pagination
3. **Save sourceRaw** — always, even if you don't have a parser
   yet
4. **Extract ALL metadata** — every field the API exposes goes
   into `IngestionResult.metadata`
5. **Write a parser** (if HTML/JSON structure allows) — produce
   `DocumentAst` blocks; call `validateAndLog()`
6. **Register** in `adapters/index.ts` and
   `adapter-registry-lazy.ts`
7. **Add adapter key** to `consts.ts` `ADAPTER_KEYS`
8. **Test with real data** — seed 3+ decisions, verify metadata
   completeness, check AST content retention

## File Map

```
case-law/
├── document-ast.ts        # Canonical AST types
├── consts.ts              # Adapter keys, timeouts
├── routes.ts              # API routes (/case prefix)
├── decisions/             # Read/list/search handlers
├── ingestion/
│   ├── adapter.ts         # SourceAdapter interface
│   ├── pipeline.ts        # Sanitize, dedup, upsert
│   ├── adapters/
│   │   ├── cz-ns.ts       # Czech Supreme Court
│   │   ├── cz-nss.ts      # Czech Supreme Admin Court
│   │   ├── cz-us.ts       # Czech Constitutional Court
│   │   ├── cz-regional.ts # Czech Regional Courts
│   │   ├── sk-courts.ts   # Slovak Courts
│   │   ├── pl-courts.ts   # Polish Courts (SAOS)
│   │   ├── at-courts.ts   # Austrian Courts (RIS)
│   │   └── eu-ecj.ts      # EU Court of Justice
│   └── parsers/
│       ├── cz-ns.ts       # NS HTML parser
│       ├── cz-nss.ts      # NSS Aspose HTML parser
│       ├── cz-us.ts       # ÚS RTF/HTML parser
│       ├── cz-regional.ts # Regional structured JSON parser
│       └── validate-ast.ts # AST content-loss validator
├── polarity/              # Citation polarity classification
└── matter-links/          # Link decisions to matters
```
