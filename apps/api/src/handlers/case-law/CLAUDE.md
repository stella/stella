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

### 9. Prefer the publisher's structure over its wording

A parser that keys off headings ("Odůvodnění", "Uzasadnienie") is
bound to one language. Where the source annotates structure —
classes, element names, `id` attributes — key off that instead, and
derive roles from position rather than from what a paragraph says.
The CJEU parser (`parsers/eu-ecj.ts`) handles all 24 official
languages, plus judgments, orders and Advocate General opinions,
with no language table: headings come from `coj-*` classes and from
the numbering scheme, paragraph numbers from the publisher's own
`id="pointN"` anchors.

Where a source also embeds the document in a page of its own — site
navigation, contact blocks, a footer — bound the parse to the document
before walking it, and derive the boundary from the same annotation.
Page furniture is not text the parser failed to classify, so rule 10
does not apply to it: emitting it as plain paragraphs puts the site's
own copy into the corpus. A list of phrases to drop is the wrong shape
for the same reason wording-based headings are; the right shape is the
deepest element holding every one of the source's own markers.

The same applies downstream: an adapter whose parser recovered the
document's headings should return `sections` on its
`IngestionResult`, so the pipeline uses those instead of falling back
to `segmentDecision`, which matches heading wording per language.

### 10. Never drop text; shape it wrong instead

Completeness and fidelity are not equal goals. If a parser cannot tell
what a piece of text is, it must still emit it — as a plain paragraph,
in document order — rather than skip it. Classification is always a
promotion from that baseline: an unrecognised heading stays a
paragraph, an element outside the source's known vocabulary still
contributes its text, a table row the shape rules do not match is
still walked for content.

A decision shown with a flat structure is visibly imperfect and a user
can still read and cite it. A decision missing a paragraph looks
complete and is wrong, and neither the reader nor the AI pipeline has
any way to know. `validateAndLog`'s CONTENT_LOSS and MISSING_WORDS are
the completeness guard and must be treated as errors; heading levels
and section boundaries are fidelity and may carry a known tail.

### 11. Emit a parse signal every stored decision is covered by

Parse quality is reported through structured logs, split by severity
along the completeness/fidelity line so an operator or an agent can
filter for the class that matters. All four carry `caseNumber`,
`language` and a `url`, because a case number alone does not identify
a document: a court publishing in 24 languages emits 24 variants under
one number, and a case can carry both a judgment and an opinion.

| Event                                       | Level | Meaning                                                                                  |
| ------------------------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `case_law.ingestion.decision_empty`         | ERROR | Stored with neither text nor AST. Nothing is readable.                                   |
| `case_law.ingestion.ast_content_lost`       | ERROR | Source text did not survive into the AST (`CONTENT_LOSS`, `MISSING_WORDS`, `EMPTY_AST`). |
| `case_law.ingestion.ast_missing`            | WARN  | Text stored, no AST: the unstructured-wall-of-text state.                                |
| `case_law.ingestion.ast_structure_degraded` | WARN  | Text is complete, structure is imperfect.                                                |

The two ERROR events are the ones to act on. Sweep for them to find
decisions worth re-ingesting after a parser fix; `sourceRaw` in S3
means most can be re-parsed without touching the court's site.

The last two events come from the pipeline rather than from a parser,
so they also cover sources whose parser never runs — which is the case
that would otherwise be silent, since a parser that is not called
cannot report anything.

### 12. Check a parser against the publisher, not against yourself

Where a source publishes the same document in two encodings, use the
more semantic one as a test oracle. Cellar serves CJEU decisions both
as the `coj-*` XHTML we parse and as Formex XML, which states heading
depth (`GR.SEQ LEVEL`), paragraph numbers (`NP.ECR/NO.P`) and the
keyword chain (`INDEX/KEYWORD`) outright. `parsers/eu-ecj.test.ts`
asserts the parse against the Formex tree, so a reviewer who does not
read Greek or Finnish can still see the parser is right in those
languages. Snapshot tests only prove the output has not changed.

### 13. Cursors must never cause full re-scans

After an adapter exhausts its range (reaches the oldest year
in a backward crawl, or the current date in a forward crawl),
the cursor must **park** at a position that only re-scans a
bounded recent window (e.g., current year). Never return
`null` from an exhausted sweep; `null` restarts the adapter
from scratch, causing an infinite re-scan loop where every
previously ingested decision is re-fetched, hash-checked,
and skipped, consuming the page budget with zero progress.

### 14. A missing continuation token is a failure, not an ending

Pagination ends when the source says there is nothing more, never
because the next-page token is absent. Treating a **full** page
with no token as "slice complete" silently drops the remainder,
and a forward-only cursor never returns to it, so the loss is
permanent and invisible.

The signature is recognisable: stored counts per slice top out at
a multiple of the page size, with slices piling up on that ceiling.

Fail loudly instead. Throwing holds the cursor and retries the
slice; a bad crawl that stops is recoverable, a bad crawl that
skips is not.

### 15. Report coverage against the source's own count

Where a source states how many records a query matched (a result
count on a search page, a `totalElements` in an API envelope),
carry it back on the page that completes the slice as
`SliceCoverage` — `{ slice, reported, collected }`. The pipeline
persists it, so a shortfall becomes a queryable row rather than
an inference.

Without it, an incomplete crawl and a genuinely quiet slice are
indistinguishable, and neither the operator nor a repair pass has
anything to act on. An adapter whose source publishes no count
omits the field; that is a known blind spot, not a silent one.

### 16. A forward-only cursor cannot repair history

An adapter that walks dates or ids in one direction and parks at
the present will never revisit what it passed. Any hole — from a
failed fetch, a truncated page, or a range crawled before a
parser fix — stays a hole forever.

So the repair path has to exist separately from the live cursor:
a reconciliation pass that reads the coverage ledger (rule 15)
and re-crawls the slices that are short. Do not rely on "it will
come around again", because it will not.

### 17. Identity is the publisher's id, never the case number

Courts number their dockets per court, so a source covering many
courts issues the same number over and over: `0T/42/2019` exists at
most Slovak district courts, `II AKa 198/23` at several Polish
appellate courts. A key built from the case number makes two
unrelated decisions the same row, and the second one stored silently
replaces the first.

So set `sourceDocumentId` on every `IngestionResult` whose source
states an id, even where the number looks unique today. It is usually
there: a `guid` in the list item, or the last segment of the detail
URL. Uniqueness is enforced on `(source_id, source_document_id)`;
sources with no such id fall back to the case number, which is sound
only because they hold a single court.

Watch for a number that embeds something other than the case: a
trailing sheet number (`-28`, číslo listu) belongs in its own optional
field, not in the docket, or one case fragments into a row per sheet
and no citation ever matches it.

### 18. Enumerate what the publisher lists; never guess identities

A predictable-looking document URL is not an enumeration API. Docket
numbers may overlap across chambers, old records may use a different URL
grammar, and one docket may publish several documents. Probing constructed
identifiers can therefore return valid decisions while silently missing a
large part of the corpus.

Prefer the publisher's search, export, sitemap, dump or list UI, even when it
is an awkward WebForms surface. Take the exact document identity and detail
URL from each listed row. If no enumeration surface exists, describe the
guessing blind spot in the adapter and coverage benchmark; do not present a
miss cutoff as proof that the source is exhausted.

### 19. Paginate a fixed set, not a moving target

Offset pagination is safe only while the matched set and ordering stay fixed.
If new records can land ahead of the cursor, every later offset moves and a
document can pass between pages unseen. Oldest-first ordering helps when new
records append at the end; otherwise persist an immutable query boundary in
the cursor and catch up from that exact boundary after the snapshot finishes.
Do not include the publisher's still-live current day in a verified snapshot.

For every non-empty slice that can still mutate — including one-page slices —
collect a digest of the exact publisher identities and make a listing-only
verification pass before writing complete coverage. A mismatch holds or
restarts the slice. A saved page that disappears after a withdrawal must also
restart from page zero, not retry the invalid offset forever. The follow-up
window must begin at the snapshot boundary plus one, not at a fresh rolling
lookback, or a long crawl/outage creates a permanent gap.

### 20. A listed document survives detail and parser failures

Once the publisher's list states that a document exists, a missing, withdrawn
or temporarily unparseable detail page must not erase that identity from the
crawl. Permanent detail absence should produce a durable listing-only result
with the exact `sourceDocumentId`, source URL and a structured reason in
metadata. Archive the verbatim listing row as `sourceRaw` when no detail
payload exists, so future parsers can repair historical metadata without
depending on a steady-state cursor rediscovering that slice. Transient network
and server failures must fail the page so its cursor is retried.
When several publisher responses form one observation, archive all of them —
listing, detail, abstract, export or equivalent — in a structured raw payload
with the matching content type. Keeping only the preferred detail response
silently discards listing-only fields and prevents future parser improvements
from being replayed across courts without another historical crawl.

If the preferred list identity is malformed but the row exposes another exact
publisher key (for example, a retrieval identifier), persist a namespaced
fallback identity rather than poisoning the page, and expose it as an alias
whenever both are visible. The shared pipeline durably reserves the canonical
identity and every exact alias to one decision UUID before inserting the row;
this mapping must work in both directions and remain atomic when canonical and
fallback observations overlap. A sequential lookup-and-migrate hint is not
sufficient: two workers can otherwise insert under different uniqueness keys.
Rolling deployments add a second race: a new worker can reserve an identity,
then an older worker can insert the unique decision row without that registry.
If a reservation points to no decision, resolve the exact identity against the
decision table and repoint the reservation to that winner so replay converges.
Validate canonical and alternate identities against the shared persistence
limit at the publisher boundary. Normalize an invalid component before it can
be used in a retrieval URL, metadata field or fallback path; dropping only its
derived alias still lets an oversized value pin the page or fail persistence.
The shared normalizer enforces the same rule for every court as a final safety
net. Publisher identities are opaque and byte-exact: if general text
sanitization would change an identity, reject the canonical value or discard
the alias. Never reserve the rewritten value, which may be another document's
legitimate exact key.
If a counted row exposes no publisher identity at all, durably quarantine its
verbatim listing payload under a content-addressed audit identity; do not let
one poison row pin every later record in the slice. Continue emitting that
quarantine fingerprint as a repair-only alias after a publisher identity
recovers, so the repair enriches the audited row instead of inserting a
duplicate. Repair-only aliases may adopt an existing row only while it is still
stored under that degraded identity; never reserve an unclaimed heuristic as
if it were an exact publisher key. Build the repair fingerprint only from
fields that remain present when identity metadata recovers: exclude the ECLI,
detail and retrieval-action labels, and any other value that can appear
together with the new exact identity, or the recovered observation will hash
differently from its quarantine row. Do not discard stable discriminators such
as the docket and sibling counter merely because an older malformed row may
lack one: use their most specific fingerprint for the quarantine identity and
emit the bounded combinations of present and absent optional discriminators as
repair-only aliases after recovery. A low-information form must never be
reserved as an exact identity.
Likewise, preserve the digit string of any numeric publisher component used to
synthesize an exact alias, or reject it unless it is a safe bounded integer;
rounding two counters to one JavaScript number silently merges documents. An
absent component stays absent—never invent a default counter merely to produce
an alias.
Mark every listing-only result with
`isListingOnly`, and, if the list also lacks a real docket, mark the durable
label with `caseNumberIsPlaceholder`. Persist every discriminator already
parsed from the listing, including sibling counters, even when detail retrieval
fails; raw HTML is an audit fallback, not the only durable representation. A
later partial refresh must never replace previously recovered detail metadata,
dates, raw payload pointers, docket or derived citation key. It may enrich an
earlier partial row;
the pipeline persists adapter-neutral observation quality so that rule applies
to every court without depending on court-specific metadata keys.
If the existing row has a pending corpus mirror, replay its stored payload to
settlement before allowing the source page to advance.

Likewise, an HTTP 200 search response is not an empty result unless the
publisher's exact no-results state is present. Fail closed on unknown markup.
These rules let a later parser or source fix enrich the same row rather than
leaving an invisible hole or creating a duplicate.

### 21. Rebuild fetch URLs from a trusted origin

Treat every URL embedded in publisher HTML or JSON as untrusted input. When an
adapter expects a known endpoint, extract only the opaque publisher identifier
and construct the request from a fixed HTTPS origin and path. Do not fetch an
absolute action URL merely because its pathname contains the expected endpoint:
a compromised result page could point the ingestion worker at a private or
metadata service.

Some publishers intentionally use several document hosts. In that case declare
the exact allowed origins in the adapter and reject everything else before any
request. Redirect handling needs the same boundary; a trusted start URL is not
enough if the client can follow it to an arbitrary origin.

### 22. Live indexing must never wait on a rebuild

A queue that only drains when some other walk completes inherits every
failure mode of that walk: a generation rebuild wedged at `running`
(spinning cursor, failing page, leaked lease, abandoned checkpoint)
silently stopped indexing every newly ingested decision. The corpus-index
pending queue therefore drains on every generation invocation — under
`running`, before the snapshot walk — so a wedged walk degrades to "rebuild
stalled", never "nothing new is searchable".

Keep that shape for any new projection or index queue: give it a drain
path that does not depend on a bounded rebuild reaching its end, and
classify the driving loop's no-progress outcomes (busy, failed) into
sustained-stall telemetry. A loop that only logs its successes makes a
leaked lease indistinguishable from an idle system.

### 23. A cited docket number names a decision only together with its court

Rule 17 from the other side. `9 A 34/2025` (Městský soud v Praze) cites
"rozsudek Krajského soudu v Českých Budějovicích ze dne 21. 5. 2025,
č. j. 65 A 3/2025-226"; the corpus held that decision and the citation
still ended `ambiguous`, because `65 A 3/2025` also exists at Krajský soud
v Brně and v Ostravě. Regional courts reuse every docket, so the key alone
can never resolve a citation of a regional decision, and the uniqueness
rule is not the one that will link it.

The citing sentence carries the missing coordinate. The extractor keeps
the court phrase as `cited_court_hint` (`citation-court-hint.ts`), the way
it keeps the decision-type word, and the resolver's `court-hint` rule links
the one time-valid holder whose court matches. Three things to hold to:

- The phrase is inflected ("Krajského soudu"); the stored court is not
  ("Krajský soud"). Compare through one normalization applied to both
  sides in the same statement (`courtNameKeySql`), never through a
  per-court spelling table that drifts from the adapters.
- A rule that reads context from the text only helps rows that were
  extracted after the column existed. Re-adjudicating old rows without
  re-extracting their citing decisions changes nothing.
- Test every positive form of a pattern, not just the negatives: `soud`
  is s-o-u-d and `súd` is s-ú-d, and `s[oú]d` matched only the Slovak
  one while the negative test passed. Assemble long patterns from named
  fragments so each part reads on its own.

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
9. **Prove the pagination terminates for the right reason** — force
   a slice larger than one page and confirm the adapter follows it
   to the end rather than stopping at a page boundary (rules 14-16)
10. **Wire the coverage count** — if the source reports a total for
    a query, return `SliceCoverage`; if it does not, say so in the
    adapter's doc comment so the blind spot is recorded
11. **Use exact listed identities** — exercise overlapping dockets and
    multiple documents under one docket; never infer uniqueness from a URL
    pattern (rules 17-18)
12. **Prove pagination against mutation** — use stable ordering or a fixed
    snapshot boundary, verify one-page and multi-page slices, and test that a
    withdrawn saved page plus an outage longer than the rolling window cannot
    leave a date gap (rule 19)
13. **Preserve listed-only records** — test a permanent missing/unparseable
    detail, a malformed primary identity with an exact fallback, a counted row
    with no identity, partial refresh after detail recovery, pending-mirror
    replay, fallback-to-canonical identity migration, archived listing HTML,
    and an unrecognised HTTP 200 search response (rule 20)
14. **Constrain detail origins** — rebuild URLs from opaque identifiers or
    test every publisher-declared origin against an explicit allowlist (rule 21)

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
│       ├── eu-ecj.ts      # CJEU Cellar XHTML parser (all languages)
│       ├── eu-ecj-formex.ts  # Formex reader; test oracle only
│       └── validate-ast.ts # AST content-loss validator
├── polarity/              # Citation polarity classification
└── matter-links/          # Link decisions to matters
```

## Backfilling the CJEU corpus

Decisions ingested before the parser landed hold `document_ast: {}`,
and their XHTML was not kept (`sourceRaw` was `undefined`), so there
is nothing to re-parse locally: the corpus has to be re-fetched.
Deploying the parser alone changes nothing for them, because the
adapter's cursor parks at the current date and never revisits a past
publication day on its own.

A re-fetch does update them. The parser's output feeds `fulltext`,
`fulltext` feeds `rawHash`, so a re-fetched decision hashes
differently from the stripped-text row already stored and the
pipeline writes the new AST, sections and metadata over it.

To backfill, set the source's `sync_cursor` back to `1952-01-01` and
let the scheduler walk forward. Every day re-fetched this way also
stores `sourceRaw`, so later parser changes can be replayed without
touching Cellar again. The crawl is rate-limited per decision, not
per language variant, so a full sweep is long-running; run it as a
deliberate operation rather than as part of a deploy.

`scripts/record-eu-ecj-fixtures.ts` reaches individual decisions by
CELEX number through the same adapter path, which is the quicker way
to re-ingest a specific case.
