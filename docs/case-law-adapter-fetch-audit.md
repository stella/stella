# Case-law adapter fetch audit

This audit covers every crawl adapter registered in
`adapter-registry.ts`; the CourtListener bulk import is intentionally excluded.
“8 h max” is the mathematical ceiling from the shared minimum interval, not a
recommended target. RIS adapters share one publisher gate, so their 5,760-request
ceiling is collective. Fixture sizes below are file sizes in the repository and
are indicative, not payload limits. A blank volume means no corpus-wide constant
or fixture total was found.

| Adapter | Cursor model | Conditional fetch | Politeness | Raw payload and later parsing | Split feasibility | Volume |
| --- | --- | --- | --- | --- | --- | --- |
| `cz-ns` | Position in an ID-ordered list (40 rows); reconciliation is by publication day. | No HTTP validator. The adapter does not use the publisher's sitemaps (declared as an excluded surface); no `since` request. | 500 ms; no daily cap; **57,600/8 h**. | Source-raw envelope containing listing and detail HTML/JSON; the page fixture is 777 KiB compressed. `reparseStoredRaw` parses without publisher I/O. | **ready** |  |
| `cz-nss` | Date plus zero-based page; advances day by day, with a 30-day initial lookback. | Date is a query boundary, but there is no ETag, `If-Modified-Since`, or updated-after request. | 500 ms; no daily cap; **57,600/8 h**. | Envelope preserves listing plus document HTML (or a listing-only observation). Replay is implemented and needs no live session. | **ready** |  |
| `cz-us` | Historical year/page sweep followed by a rolling recent window/frontier. | Search constraints bound years/recent dates; no HTTP validator. The ASP.NET search requires hidden form/session state during fetch, but that state is not needed by replay. | 18,000 ms; stated cap 5,000/day, gate budgets 4,800/day; **1,600/8 h**. | Envelope preserves result card and fetched decision HTML/RTF inputs; fixtures range from 6 KiB to 474 KiB compressed. Replay is implemented. | **ready** |  |
| `cz-regional` | Date plus zero-based page, advancing daily after an initial 30-day lookback. | Publication-date query only; no response validator or change feed. | 500 ms; no daily cap; **57,600/8 h**. | Envelope contains listing, final-document JSON and chain JSON; fixtures are about 0.2–11 KiB compressed. Replay is implemented. | **ready** |  |
| `sk-courts` | Stable date/frontier walk with pages (100 in crawl; larger reconciliation pages). | Date filters only; no validator on the case listing. Separate collection-file refresh code does use ETag/`If-None-Match` and Last-Modified, but that is not this adapter's `fetchPage` path. | 500 ms; no daily cap; **57,600/8 h**. | Envelope stores listing/detail metadata; document delivery is already **deferred**. The listing fixture is 34 KiB compressed. Replay is implemented; the later document stage performs its own bounded retrieval. | **ready** (already separates document delivery) |  |
| `sk-us` | Year/offset crawl with bounded recent reconciliation. | No validator in `fetchPage`. A publisher sitemap exists but is explicitly excluded; collection files elsewhere use ETag/Last-Modified. | 500 ms; no daily cap; **57,600/8 h**. | Envelope includes listing, content metadata and file/PDF material; fixtures span about 1–220 KiB compressed. Replay is implemented. | **ready** |  |
| `pl-courts` | Publication-day slices with page/offset traversal. | Date-range search is used as the incremental boundary; no ETag or Last-Modified request. | 500 ms; no daily cap; **57,600/8 h**. | Envelope preserves search/listing and detail/reasons JSON. Fixtures range from 2 KiB details to 2.1 MiB compressed pages. Replay is implemented. | **ready** |  |
| `pl-sn` | Month/day and page walk over the JSON search results. | Date-bounded search; no HTTP validator or updated-after watermark. | 1,500 ms; no daily cap; **19,200/8 h**. | Envelope stores listing and decision responses; the page fixture is 159 KiB compressed. Replay is implemented. | **ready** |  |
| `pl-kio` | Month/page slices, including a separate undated slice. | Date query only; no HTTP validator or change feed. | 1,000 ms; no daily cap; **28,800/8 h**. | Envelope stores listing, detail and content HTML; fixtures are roughly 2–25 KiB each. Replay is implemented. | **ready** |  |
| `pl-tk` | Separate merits/preliminary page-number walks. | Full paged lists; no ETag, Last-Modified, since parameter, sitemap, or feed. | 1,500 ms; no daily cap; **19,200/8 h**. | Envelope preserves listing/detail HTML; listing fixtures are about 3–5 KiB compressed. Replay is implemented. | **ready** |  |
| `pl-nsa` | Full list from a pinned Parquet dataset, advanced by row/shard position. | Pinned dataset artifact; no per-page HTTP validator in the adapter. | 500 ms; no daily cap; **57,600/8 h**. | Stored row JSON is sufficient for `reparseStoredRaw`; fixture is 108 KiB JSON (62 KiB Parquet). Dataset reader state is fetch-only state. | **ready** |  |
| `pl-ncourt` | Keyset/offset walk of the full XML list, plus date slices for reconciliation. | Date query is available for slices; no HTTP cache validator. | 1,000 ms; no daily cap; **28,800/8 h**. | Envelope stores listing, detail and content XML/HTML; fixtures are about 0.1–21 KiB each. Replay is implemented. | **ready** | **465,960** (total fixture) |
| `at-courts` | Month slice plus page; each slice is reread in a verification phase. | RIS exposes a change feed, but this adapter uses monthly search and the source-surface census excludes the feed; no ETag/Last-Modified. | 5,000 ms; no daily cap; **5,760/8 h shared across RIS**. | Envelope-like listing/detail material is built and parsed inline, but the adapter has **no `reparseStoredRaw`**. The page fixture is 27 KiB compressed; listing fixture 33 KiB. | **needs-change**: archive every listing/detail response and add offline replay. |  |
| `at-vfgh` | RIS month/page plus verification pass. | RIS change feed exists but is not consumed; no validator. | 5,000 ms; **5,760/8 h shared across RIS**. | Same RIS inline builder; no replay. Listing fixtures are 2–46 KiB. | **needs-change**: store complete RIS envelope and add replay. |  |
| `at-vwgh` | RIS month/page plus verification pass. | RIS change feed exists but is not consumed; no validator. | 5,000 ms; **5,760/8 h shared across RIS**. | Same RIS inline builder; no replay. Listing fixture is 1.8 KiB. | **needs-change**: store complete RIS envelope and add replay. |  |
| `at-bvwg` | RIS month/page plus verification pass. | RIS change feed exists but is not consumed; no validator. | 5,000 ms; **5,760/8 h shared across RIS**. | Same RIS inline builder; no replay. Listing fixture is 78 KiB. | **needs-change**: store complete RIS envelope and add replay. |  |
| `at-lvwg` | RIS month/page plus verification pass. | RIS change feed exists but is not consumed; no validator. | 5,000 ms; **5,760/8 h shared across RIS**. | Same RIS inline builder; no replay. Listing fixture is 34 KiB. | **needs-change**: store complete RIS envelope and add replay. |  |
| `at-asylgh` | RIS month/page plus verification pass. | RIS change feed exists but is not consumed; no validator. | 5,000 ms; **5,760/8 h shared across RIS**. | Same RIS inline builder; no replay. Listing fixture is 90 KiB. | **needs-change**: store complete RIS envelope and add replay. |  |
| `at-ubas` | RIS month/page plus verification pass. | RIS change feed exists but is not consumed; no validator. | 5,000 ms; **5,760/8 h shared across RIS**. | Same RIS inline builder; no replay. Listing fixture is 1.9 KiB. | **needs-change**: store complete RIS envelope and add replay. |  |
| `at-uvs` | RIS month/page plus verification pass. | RIS change feed exists but is not consumed; no validator. | 5,000 ms; **5,760/8 h shared across RIS**. | Same RIS inline builder; no replay. Listing fixture is 1.8 KiB. | **needs-change**: store complete RIS envelope and add replay. |  |
| `at-verg` | RIS month/page plus verification pass. | RIS change feed exists but is not consumed; no validator. | 5,000 ms; **5,760/8 h shared across RIS**. | Same RIS inline builder; no replay. Listing fixture is 2.0 KiB. | **needs-change**: store complete RIS envelope and add replay. |  |
| `at-umse` | RIS month/page plus verification pass. | RIS change feed exists but is not consumed; no validator. | 5,000 ms; **5,760/8 h shared across RIS**. | Same RIS inline builder; no replay. Listing fixture is 1.8 KiB. | **needs-change**: store complete RIS envelope and add replay. |  |
| `at-bks` | RIS month/page plus verification pass. | RIS change feed exists but is not consumed; no validator. | 5,000 ms; **5,760/8 h shared across RIS**. | Same RIS inline builder; no replay. Listing fixture is 5.0 KiB. | **needs-change**: store complete RIS envelope and add replay. |  |
| `at-findok` | Two full paged lists (UFS and BFG), carried in a compound cursor. | Full list; no ETag, Last-Modified, since parameter, sitemap, or feed. | 1,500 ms; no daily cap; **19,200/8 h**. | Parsed inline from search/detail responses; **no `reparseStoredRaw`**. | **needs-change**: archive all responses and add replay. |  |
| `eu-ecj` | Publication date; one bounded SPARQL slice per day, then the next date. | SPARQL date range is the incremental boundary. The listing exposes no content-change signal; no ETag/Last-Modified is used for Cellar reads. | 1,000 ms; no daily cap; **28,800/8 h**. | Envelope stores SPARQL row, notice XML and language XHTML; fixtures include 8 KiB listing, 79–83 KiB notice, and 227–232 KiB XHTML. Replay is implemented. | **ready** |  |
| `hu-bhgy` | Snapshot-bound historical year/category/offset sweep, then a publication-frontier tip walk. | Snapshot boundary and publication sorting prevent moving pages; no HTTP validator or updated-after endpoint. | 500 ms; no daily cap; **57,600/8 h**. | Envelope stores listing metadata and DOCX/RTF document bytes represented for replay; listing fixture is 6.4 KiB. Replay is implemented. | **ready** |  |
| `pl-kis` | Undated pass, historical month/page sweep, then a month frontier. | Month/date search boundary; no HTTP validator or change feed. | 1,000 ms; no daily cap; **28,800/8 h**. | Envelope stores listing/detail JSON and PDF as a raw object; fixtures are 1–30 KiB JSON plus a 52 KiB PDF. Replay is implemented. | **ready** |  |
| `pl-uodo` | Keyset change walk ordered by `mtime` then event ID. | **Uses a change watermark**: search conditions request `mtime >=`/`>` the cursor (with ID tie-break). No ETag/Last-Modified. | 1,000 ms; no daily cap; **28,800/8 h**. | Envelope stores listing and fetched body variants; listing fixture is 37 KiB compressed. Replay is implemented. | **ready** |  |
| `pl-uokik` | Oldest-to-newest full view walk, then a head/tip cursor anchored to the view total. | No HTTP validator or change feed; the view total detects structural movement but still requires reads. | 2,000 ms; no daily cap; **14,400/8 h**. | Envelope stores view row, detail HTML and downloaded PDF/image objects; detail fixtures are 24–27 KiB. Replay is implemented. | **ready** | **22,253** (view fixture) |

## Summary

### Ready to split

The 17 adapters with an offline replay implementation are ready for a
fetch/store/enqueue boundary: `cz-ns`, `cz-nss`, `cz-us`, `cz-regional`,
`sk-courts`, `sk-us`, `pl-courts`, `pl-sn`, `pl-kio`, `pl-tk`, `pl-nsa`,
`pl-ncourt`, `eu-ecj`, `hu-bhgy`, `pl-kis`, `pl-uodo`, and `pl-uokik`.
Fetch still must finish every response that forms an observation before it
enqueues that observation. In particular, ASP.NET session state and all detail,
document, or language follow-up requests remain in the fetch task; parsing uses
only the completed stored envelope and raw objects. The pipeline currently
fetches and applies each page in one loop, so implementing the scheduling split
still requires a durable object-write and enqueue boundary before checkpointing.

The eleven RIS adapters and `at-findok` need a complete stored-response envelope
and `reparseStoredRaw`. None is intrinsically unsplittable; their present inline
builders are the blocker.

### Conditional-fetch opportunities

1. **RIS (all eleven adapters): consume the publisher's change feed.** This has
   the largest likely reduction because the current design rereads every page of
   every monthly slice and then repeats the slice for verification.
2. **Sources with full/head rescans:** `pl-uokik`, `at-findok`, and `pl-tk` have
   no content validator. A documented publisher watermark or validator would
   avoid unchanged list/detail reads; no such support is evidenced in the
   adapter or fixtures today.
3. **Already exploited:** `pl-uodo` is the strongest current model because its
   `mtime` plus ID keyset asks only for records after the durable watermark.
   The Slovak collection downloader also conditionally revalidates files with
   ETag, falling back to Last-Modified, though that helper is outside the
   registered adapters' case-list `fetchPage` paths.

### Eight-hour catch-up limits

No repository fixture or constant establishes a daily arrival volume above its
publisher gate's eight-hour ceiling, so no adapter can be proven unable to keep
up with **new daily documents**. Historical backfill is different: the NALUS
adapter can issue only 1,600 requests in eight hours, the shared RIS publisher
only 5,760, and `pl-uokik` only 14,400. A full UOKiK view fixture states 22,253
records, so even one request per record cannot finish that corpus in one window;
RIS capacity is shared by eleven adapters and its verification pass doubles
listing reads. These are bounded multi-window backfills, not evidence of a
daily-arrival deficit.

## Repository evidence

- Registry and capability boundary: `apps/api/src/handlers/case-law/ingestion/adapters/adapter-registry.ts`.
- Publisher ownership and shared-gate mapping: `apps/api/src/handlers/case-law/ingestion/adapters/publisher-policy.ts`.
- Intervals and the NALUS stated cap: `apps/api/src/lib/legal-search/publisher-gates.ts`.
- Fetch/apply coupling and stored-raw replay use: `apps/api/src/handlers/case-law/ingestion/pipeline.ts`.
- RIS change-feed exclusion: `apps/api/src/handlers/case-law/ingestion/adapters/at-ris-source-surfaces.ts` and `at-ris-fields.ts`.
- Conditional Slovak collection reads: `apps/api/src/handlers/case-law/ingestion/adapters/sk-collections.ts` and `sk-collections.test.ts`.
- Sizes and stated totals: files under `apps/api/src/handlers/case-law/ingestion/adapters/__fixtures__/`.
