# Austrian case-law source decision

Research date: 2026-08-11

## Decision

Use the Austrian Federal Legal Information System (RIS) Open Government Data
API, beginning with the `Justiz` application. It is the official, enumerable,
machine-readable publication surface for the Supreme Court (OGH) and selected
higher regional, regional, and district court decisions. Keep the other RIS
applications as separate follow-up slices: their response metadata differs,
and combining five independently paginated result sets would hide source
boundaries inside one cursor.

The existing `at-courts` adapter is not ready to activate. It omits the API's
mandatory `Applikation` parameter, does not adopt the RIS document ID, strips
HTML instead of parsing the richer XML, stores no raw document, and paginates a
moving modification-date result set. The first implementation should replace
those mechanics rather than add a second Austrian source key.

## Source matrix

| Candidate | Corpus and court coverage | Enumeration and format | Publisher total | Licence and access constraints | Decision |
| --- | --- | --- | --- | --- | --- |
| [RIS OGD API](https://www.data.gv.at/datasets/0fb9ae1a-92cb-4ab8-a589-470c16d4fe21) | National official system. The five principal decision-text applications reported 669,749 documents on the research date: Justiz 172,213; VfGH 25,728; VwGH 140,390; BVwG 287,126; LVwG 44,292. `Justiz` contains all OGH decisions since 1991, important earlier OGH decisions, selected OLG/LG/BG decisions, and 2,200 foreign-court documents under `AUSL`; the Austrian first-source scope is therefore 170,013. | `GET https://data.bka.gv.at/ris/api/v2.6/Judikatur`; mandatory `Applikation`; exact decision-text selection; inclusive `EntscheidungsdatumVon`/`Bis`; deterministic date sort; 1-based pages of up to 100. Each listing row carries `Technisch.ID`, metadata, and direct XML, HTML, RTF, and PDF URLs. XML preserves publisher sections such as `Kopf`, `Spruch`, `Text`, and `Rechtliche Beurteilung`. | `Hits.#text` states the matched count on every response. | [CC BY 4.0](https://www.ris.bka.gv.at/UI/Ogd.aspx), no registration. The [OGD FAQ](https://www.ris.bka.gv.at/RisInfo/OGD-FAQ.pdf) asks clients to pause 1–2 seconds between pages, run bulk downloads outside 06:00–18:00 or on weekends, and notify `ris.it@bka.gv.at` before an initial mass download. `www.ris.bka.gv.at/robots.txt` currently states `crawl-delay: 5`; use the stricter five-second interval. | **First source**, scoped initially to Austrian documents in `Justiz`. |
| [Constitutional Court site](https://www.vfgh.gv.at/service/anlaufstellen/registry.en.html) | The court says all decisions from 1980 onward are available without charge; its printed official collection covers more than 20,000 cases, while pre-1980 material is in the Austrian National Library's ALEX portal. | The court's own site presents selected current/public-interest material. Its registry identifies RIS as the prompt, searchable full-text publication system. No independent complete list, stable API, or publisher total was found on the court site. | No own-site total; RIS `Vfgh` reported 25,728 decision texts. | Ordinary site terms/robots apply; the complete machine surface is RIS OGD. | Do not duplicate RIS. Add a dedicated RIS `Vfgh` adapter later so its metadata contract stays explicit. |
| [Administrative Court site](https://www.vwgh.gv.at/rechtsprechung/index.html) | The VwGH states that all decisions since 1990 are continuously recorded in RIS; selected older decisions also exist there. | Own site exposes recent decisions and public-interest selections, then links to RIS for the complete collection. No independent complete paging API or total was found. | No own-site total; RIS `Vwgh` reported 140,390 decision texts, including selected historical material. | Ordinary site terms/robots apply; RIS OGD governs machine access to the complete set. | Do not crawl the selected own-site feed. Add RIS `Vwgh` later. |
| [Justice/OGH publication](https://www.ris.bka.gv.at/UI/Judikatur/Justiz/Kontakt.aspx) | OGH, OLG, LG, BG, and a small foreign-court subset. All OGH decisions since 1991; important criminal decisions since 1976 and civil decisions since 1984; selected OLG from 1995 and LG from 1996. | The Ministry of Justice describes the free decision database as part of RIS. RIS OGD is the complete list and supplies stable document IDs plus XML/HTML/RTF/PDF detail. | RIS `Justiz` reported 172,213 decision texts; the exact `Gericht=AUSL` query reported 2,200, leaving 170,013 Austrian documents. | RIS OGD CC BY 4.0 and its politeness rules apply. | This is the first implementation tranche. Exclude `Organ` values beginning with `AUSL` so the country remains `AUT`. |
| Regional administrative court sites | Nine Länder courts. RIS documents selected LVwG decisions from 2014; the live result set also contains a small amount of older predecessor material. | Individual court sites are fragmented and often publish selected/current decisions. RIS exposes one enumerable `Lvwg` application with date filters, `Bundesland`, stable IDs, and four detail formats. | RIS `Lvwg` reported 44,292 decision texts; no authoritative combined total was found on the nine own sites. | Individual portal rules vary. RIS OGD offers one documented licence and politeness contract. | Later RIS `Lvwg` adapter; do not maintain nine crawlers first. |
| [Federal Fiscal Court / Findok](https://findok.bmf.gv.at/findok/hilfe/EFSZ/BMF/FINDOK-INT-2/Inhalt-der-Findok.html) | BFG decisions from 2014 and predecessor UFS material. This corpus is outside the five RIS applications above. | Search UI has full text, date, docket, ECLI, decision/headnote selection, and stable-looking UUID document IDs. Its IWG inventory offers downloadable holdings lists, but an inexpensive publisher total and documented stable paging API still need verification. | Not established in this research pass. | Findok states that BFG/UFS documents are anonymised; § 23 BFGG may prevent publication when substantial private or public interests oppose it. Terms and bulk-download expectations need a separate review. | Valuable second-source expansion after RIS, not part of the first adapter. |
| ALEX historical constitutional collection | Selected constitutional decisions before 1980. | Scanned historical volumes, not a modern decision-level API. Enumeration is volume/page oriented; OCR and stable decision mapping require separate research. | The VfGH says its printed collection has documented more than 20,000 cases overall, not a machine-readable ALEX decision total. | Austrian National Library terms apply. | Historical follow-up only. |
| Commercial databases (RDB, Lexis 360, MANZ, juris equivalents) | Broader editorial collections, headnotes, and commentary. | Contractual/search surfaces, not a public ingestion API. | Subscription-dependent. | Commercial terms and database rights. | Out of scope. |

The five live totals came from identical RIS queries selecting
`Dokumenttyp.SucheInEntscheidungstexten=true`, page 1, and sorting by decision
date for `Justiz`, `Vfgh`, `Vwgh`, `Bvwg`, and `Lvwg`. They are publisher query
totals, not claims that every decision ever rendered is published.

## Enumeration design for `Justiz`

- Slice by calendar month (`YYYY-MM`), from `1925-04` through the current UTC
  month. A month is re-askable, sorts in walk order, and is comfortably below
  the reconciliation engine's 200-page ceiling at the API's 100-document page
  size.
- Ask for decision texts only:
  `Applikation=Justiz`,
  `Dokumenttyp.SucheInEntscheidungstexten=true`,
  `EntscheidungsdatumVon=YYYY-MM-01`,
  `EntscheidungsdatumBis=<month end>`,
  `Sortierung.SortDirection=Ascending`,
  `Sortierung.SortedByColumn=Datum`,
  `DokumenteProSeite=OneHundred`, and a 1-based `Seitennummer`.
- Treat `Metadaten.Technisch.ID` as the opaque `sourceDocumentId`. Use the same
  identity helper for crawl results, reconciliation listings, and detail
  builds. Never key on `Geschaeftszahl`: one docket can have multiple published
  texts, and the API separately publishes headnotes.
- Read the publisher total from `OgdDocumentResults.Hits.#text`. A parsed zero
  is an empty slice; non-2xx, timeout, malformed JSON, or an unrecognised
  envelope throws and leaves the cursor/slice unsettled.
- Fetch the listed XML URL only after constraining it to HTTPS RIS document
  paths derived from the listed ID. XML is richer than stripped HTML and is
  retained verbatim as `sourceRaw`; HTML remains the human-facing document
  URL.
- The forward crawl walks closed months and then rechecks the current month.
  Reconciliation independently walks every month, with a recent tip window,
  so later publication of an old decision is repairable.
- Page a fixed monthly query. Before declaring a mutable month complete, the
  adapter must verify the exact listed-identity digest or otherwise hold the
  slice; offset pagination over a live global modification sort is not safe.

The 2026-08-11 `Justiz` query reported **172,213** decision-text documents;
the companion `Gericht=AUSL` query reported **2,200**, leaving an Austrian
publisher total of **170,013**. `getTotalCount` must issue both queries and
subtract the foreign subset, so the benchmark and crawl measure the same
publisher universe.

## Legal and data-handling notes

[§ 7 Austrian UrhG](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10001848&Paragraf=7)
states that laws, regulations, official decrees, notices, and decisions do not
receive copyright protection. RIS nevertheless distributes its OGD data under
CC BY 4.0, so downstream use must retain the required source attribution.

RIS publication is already anonymised or pseudonymised by the responsible
court workflow. For example, [§ 15 OGHG practice described in RIS](https://www.ris.bka.gv.at/JustizEntscheidung.wxe?Abfrage=Justiz&Dokumentnummer=JJT_20181219_OGH0002_0080OB00140_05D0000_000&IncludeSelf=True)
requires names, addresses, and identifying locations to be masked while
preserving comprehensibility. That is not a guarantee that every historical
document is perfectly redacted; Stella must preserve the publisher text and
must not attempt to reverse anonymisation.

Austria assigns ECLI when covered decisions are published online. The
[European e-Justice description](https://e-justice.europa.eu/topics/legislation-and-case-law/european-case-law-identifier-ecli/at_en)
lists the VfGH, OGH and other courts, BVwG, BFG, LVwG, and the data-protection
authority. Capture `EuropeanCaseLawIdentifier` exactly where present.

## Explicit follow-ups

- Add separate RIS adapters for `Vfgh`, `Vwgh`, `Bvwg`, and `Lvwg`, reusing the
  transport and XML parser while keeping each publisher application, count,
  cursor, and metadata schema visible.
- Research Findok's IWG inventory and machine endpoints for BFG/UFS coverage.
- Research ALEX decision-level enumeration and OCR quality for pre-1980 VfGH
  material.
- Austrian citation extraction and report-series handling are out of scope for
  the first adapter and reconciliation commits.
