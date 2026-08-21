# Austrian case-law source decision

Research dates: 2026-08-11 to 2026-08-12

## Decision

Use the official RIS Open Government Data API for every enumerable RIS court
and historical adjudicatory collection. Use the official Findok IWG holdings
manifests for BFG and UFS fiscal decisions. Keep each RIS application as its own
source because its publisher count, metadata branch, cursor, and successor
boundary are independent. Keep BFG and UFS in one Findok source whose lexical
year slices preserve the UFS-to-BFG successor chain.

Do not scrape the courts' selected “current decisions” pages: they overlap the
complete machine surfaces. Do not claim that the official publication corpus is
every case disposed of in Austria. Publication statutes, court selection rules,
and historical digitisation gaps mean it is the broadest enumerable official
corpus, not the universe of court files.

The observed, currently valid scope is **823,238 official documents**:

- 738,176 Austrian RIS decision texts across ordinary courts, the five current
  public-law court collections, AsylGH, and five closed adjudicatory archives;
- 85,062 current Findok inventory entries across BFG and UFS.

Counts are point-in-time publisher counts, not timeless completeness claims.
Adapters obtain their benchmark from the live publisher surfaces.

## Source matrix

| Official surface                                                                                                                                                                                                      | Published scope and observed count                                                                                                                                                    | Enumeration and identity                                                                                                                                                                                                                                                     | Formats, licence, and access                                                                                                                                                                                                                                                     | Decision                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RIS OGD](https://www.data.gv.at/datasets/0fb9ae1a-92cb-4ab8-a589-470c16d4fe21)                                                                                                                                       | `Justiz` 172,213 texts, including 2,200 `AUSL` foreign documents; Austrian scope 170,013. `Vfgh` 25,728; `Vwgh` 140,415; `Bvwg` 287,371; `Lvwg` 44,292.                               | `GET https://data.bka.gv.at/ris/api/v2.6/Judikatur`; mandatory `Applikation`; decision-date range; deterministic date sort; 1-based pages of 100; total in `Hits.#text`; publisher identity in `Metadaten.Technisch.ID`.                                                     | XML, HTML, RTF, and PDF links per listing. [CC BY 4.0](https://www.ris.bka.gv.at/UI/Ogd.aspx). The [OGD FAQ](https://www.ris.bka.gv.at/RisInfo/OGD-FAQ.pdf) asks bulk clients to pause, use off-hours, and coordinate initial mass downloads; RIS robots specifies five seconds. | Primary surface. One adapter per application, with one distributed five-second publisher gate shared by listings, details, totals, and retries.                  |
| RIS historical court and adjudicatory applications                                                                                                                                                                    | `AsylGH` 52,219 (2008–2013); `Ubas` 3,625 (1998–2008); `Uvs` 9,830 (1991–2013); `Verg` 3,935 (1994–2013); `Umse` 370 (1995–2013); `Bks` 378 (2001–2013).                              | Same OGD envelope and technical ID. Closed first/last month boundaries make every archive re-askable without querying nonexistent future periods.                                                                                                                            | Same RIS XML and CC BY 4.0 contract.                                                                                                                                                                                                                                             | Separate sources. These preserve UBAS → AsylGH → BVwG, UVS → LVwG, and historical review-body boundaries without docket-based deduplication.                     |
| [VfGH own site](https://www.vfgh.gv.at/rechtsprechung/rechtsprechung_ueberblick.de.html)                                                                                                                              | Decisions from 1980 and about two-thirds of published pre-1980 case law are in RIS; the German overview narrows publication to Erkenntnisse and selected Beschlüsse.                  | Own “current decisions” pages are selected PDFs without an independent complete list or total.                                                                                                                                                                               | Ordinary site rules; RIS is the linked machine corpus.                                                                                                                                                                                                                           | Do not duplicate RIS. Historical remainder belongs to ALEX research.                                                                                             |
| [VwGH own site](https://www.vwgh.gv.at/rechtsprechung/index.html)                                                                                                                                                     | The court says all decisions since 1990 are continuously captured in RIS. Older coverage is selected/backfilled.                                                                      | Own current/public-interest page is selected; no second complete API or total was found.                                                                                                                                                                                     | Ordinary site rules; RIS is canonical.                                                                                                                                                                                                                                           | Do not duplicate RIS.                                                                                                                                            |
| Individual BVwG and LVwG sites                                                                                                                                                                                        | BVwG material begins in 2014. RIS expressly describes LVwG publication as selected across all nine Länder courts; its API also contains legacy-dated predecessor material.            | Own sites link to RIS or publish selected/current material. RIS provides one complete enumerable publisher holding for each application.                                                                                                                                     | RIS access contract applies.                                                                                                                                                                                                                                                     | Use RIS `Bvwg` and `Lvwg`, not ten fragile site crawlers.                                                                                                        |
| [Findok IWG downloads](https://findok.bmf.gv.at/findok/hilfe/EFSZ/BMF/FINDOK-INT-2/BENUTZERUNTERST-TZUNG/Dokumentendownload.html)                                                                                     | BFG: 39,872 valid entries from 2014. UFS predecessor: 45,190 valid entries from 2003–2013.                                                                                            | Weekly complete gzipped JSON inventories at `bestandsliste-bfg.gz` and `bestandsliste-ufs.gz`; each row has UUID `dokumentId`, `stammNr`, docket, date, authority, ZIP/PDF paths, and validity. Adopt `dokumentId`; pin crawling to a manifest hash; slice by decision year. | ZIP contains decision XML with embedded XHTML; PDF is directly listed. Findok documents are **CC0**. Use a shared 1.5-second publisher gate and bounded archive/XML reads.                                                                                                       | Second primary surface. Treat native BFG/UFS manifests as one successor-chain source; never ingest Findok search results blended from external RIS/VwGH sources. |
| [ALEX VfGH](https://alex.onb.ac.at/vgh.htm), [ALEX VwGH](https://alex.onb.ac.at/cgi-content/alex?aid=vgr&apm=0), historical [Reichsgericht](https://alex.onb.ac.at/rgr.htm) and [OGH](https://alex.onb.ac.at/ogh.htm) | Official historical published volumes, including VfGH 1919–1979, VwGH volumes from 1876, Reichsgericht 1869–1918, and historical OGH civil collections. Substantial overlap with RIS. | Volume/page/scan enumeration; no verified complete per-decision listing API, stable decision identity, OCR boundary, publisher decision total, or reuse licence for the digitised artifacts was found.                                                                       | ÖNB site rules apply. OCR and decision segmentation would create identities not enumerated by the publisher.                                                                                                                                                                     | Do not activate as an ingestion adapter. Treat as a dedicated research/OCR project with a source-held volume/page identity design.                               |
| Commercial databases                                                                                                                                                                                                  | Editorially broader discovery, headnotes, cross-references, commentary, and sometimes additional selected decisions.                                                                  | Contractual search products, not public official enumeration APIs.                                                                                                                                                                                                           | Subscription and database terms.                                                                                                                                                                                                                                                 | Out of scope; do not use as an ingestion source.                                                                                                                 |

## RIS enumeration design

- Ask for decision texts only with
  `Dokumenttyp.SucheInEntscheidungstexten=true`; querying decision texts and
  headnotes together double-counts publisher artifacts.
- Slice by closed calendar month (`YYYY-MM`) from each application's earliest
  listed month through the last complete UTC month. Closed archives also have a
  fixed terminal month.
- Page with `DokumenteProSeite=OneHundred`, 1-based `Seitennummer`, ascending
  decision date, and inclusive `EntscheidungsdatumVon`/`Bis` boundaries.
- Refuse a month above 200 pages (20,000 texts) in both crawl and
  reconciliation; a newly oversized application must move to finer slices
  rather than silently truncate.
- Validate the returned page number and page size. Collect and then verify the
  exact listed-identity digest before reporting coverage; a changed set restarts
  the slice.
- Use `Metadaten.Technisch.ID` once for crawl, reconciliation listing, and build.
  A missing or malformed ID receives a content-addressed quarantine identity so
  one bad row cannot pin the slice.
- Read the total from `Hits.#text`. Only a parsed zero means empty; HTTP failure,
  timeout, malformed JSON, or an unfamiliar envelope throws.
- Fetch only the ID-derived, publisher-listed HTTPS XML path. Retain listing and
  XML in `sourceRaw`; expose the listed HTML URL to readers.
- `Justiz` alone excludes `Organ` beginning `AUSL`; its total subtracts the exact
  publisher `Gericht=AUSL` subset so source scope and benchmark agree.
- A Redis-time gate serialises all RIS requests across sources and deployed
  runner replicas. Local/test runs use an equivalent process gate.

The [RIS URL manual](https://ris.bka.gv.at/RisInfo/LinksaufDokumenteimRISsetzen.pdf)
documents stable application/document links and date filters. The OGD FAQ also
documents history queries for changed or deleted documents; those are a later
incremental-efficiency option, not a substitute for reconciliation.

## Findok enumeration design

- Download the two official weekly manifests, validate every row and duplicate
  identity, retain only `gueltig=true`, and report the sum as the source total.
- Adopt UUID `dokumentId` as `sourceDocumentId`; retain `stammNr`, collection,
  title, publication timestamp, and the original manifest row. A malformed UUID
  receives a stable quarantine identity plus a repair alias when corrected.
- Walk lexical successor slices `2003-ufs` … `2013-ufs`, `2014-bfg` … current
  year. The largest observed annual sets were 4,731 UFS documents (2012) and
  3,604 BFG documents (2015): 48 and 37 pages respectively, safely below
  reconciliation's 200-page limit at 100 identities per page.
- Cache a validated manifest briefly, pin crawl cursors to its content hash, and
  restart rather than bank coverage if the weekly snapshot changes mid-walk.
- Fetch only the exact manifest-derived ZIP path. Bound compressed bytes, entry
  count, uncompressed XML bytes, and total expansion before parsing the embedded
  XHTML. Retain manifest listing plus publisher XML as raw source.
- Treat 404/410 as absent detail. Transient failures and malformed archives
  throw; reconciliation never stores a hollow listing-only decision.

## Legal and coverage notes

[§ 7 Austrian UrhG](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10001848&Paragraf=7)
excludes official decisions from copyright protection. RIS nevertheless applies
CC BY 4.0, so its attribution is retained. Findok explicitly publishes its IWG
documents under CC0.

Published decisions are already anonymised or pseudonymised by the responsible
court workflow. Stella preserves the official text and must not try to reverse
anonymisation. Historical documents can still contain imperfect redactions, so
official publication is not a reason to treat text as nonsensitive operational
data.

The [European e-Justice ECLI description](https://e-justice.europa.eu/topics/legislation-and-case-law/european-case-law-identifier-ecli/at_en)
lists Austrian participating courts including VfGH, OGH, BVwG, BFG, and LVwG.
Capture the publisher ECLI exactly where present.

BFG publication is constrained by § 23 BFGG and can omit decisions for protected
interests or limited significance. RIS ordinary, historical, and LVwG holdings
also contain expressly selected subsets. Commercial providers can therefore be
better research products without being better official completeness benchmarks:
they add editorial selection, citation networks, journals, and commentary, while
the official adapters measure only what each publisher says it holds.

Administrative-authority collections such as DSB/DSK, disciplinary commissions,
equal-treatment commissions, PVAK, and UPTS are official legal decisions but are
not court case law. They remain outside the default court corpus unless Stella
introduces an explicit adjudicatory-authority source category.

## Deferred work

- ALEX volume segmentation, OCR quality, stable publisher-held identity, licence,
  and overlap reconciliation require a separate project before ingestion.
- RIS change/deletion history can later reduce steady-state reconciliation cost.
- Austrian citation extraction and report-series handling remain out of scope.
