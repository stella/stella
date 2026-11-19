# cz-ns-sbirka publisher research

Research date: 2026-11-18. Source key: `cz-ns-sbirka`. Publisher: Nejvyšší
soud, the same court whose decision database `cz-ns` reads; this is its
official collection, the Sbírka soudních rozhodnutí a stanovisek, at
https://sbirka.nsoud.cz.

## What the collection is

The printed collection, digitised: decisions and opinions the Supreme Court
selected and edited for publication, numbered per collection year (ročník) in
two series, a civil part (Rozhodnutí ve věcech občanskoprávních, obchodních a
správních) and a criminal part (Rozhodnutí ve věcech trestních), plus
stanoviska and the plenary and collegium materials printed with them. It holds
decisions of the Supreme Court, of its predecessors (Nejvyšší soud ČSSR, ČSR,
SSR, SR, ČSFR), of the high, regional and city courts it chose to print, and
the interwar Supreme Court's decisions from the Vážný volumes. Some entries are
in Slovak; the court label does not say which.

Licensing facts: court decisions are official works under § 3 písm. a) of
zákon č. 121/2000 Sb.; the site states no licence or terms, only "©2026
Nejvyšší soud"; robots.txt allows everything.

## Surfaces

| Surface             | Address                                                                        | Use                                                           |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Sitemap index       | `/sitemap_index.xml` (Yoast)                                                   | lists the collection sitemaps                                 |
| Collection sitemaps | `/collection-sitemap.xml`, `/collection-sitemap2.xml` … `10`                   | every entry URL with its `lastmod`; the crawl's listing       |
| Issue sitemaps      | `/year-collection-sitemap.xml`, `…2.xml`                                       | 1,309 taxonomy pages (years, parts, issues); not read         |
| Detail page         | `/sbirka/<post id>/`                                                           | every field and the text; stored as `detail`                  |
| Year archive        | `/year-collection/rok-<year>/`, `/year-collection/vazny/`, paged `strana/<n>/` | seven entries a page; reconciliation                          |
| PDF export          | `/export/sbirky?collectionIds=<id>`                                            | a rendering of the same entry; address kept, bytes not stored |
| ePUB export         | `/export/epub-sbirky?epubCollectionIds=<id>`                                   | as the PDF                                                    |

No WordPress REST type exposes the collection.

Counts on 2026-11-18: the collection sitemaps list 9,832 entries (ten
sitemaps, 1,000 each and 832 in the last), ordered by `lastmod` across the
whole set, so an entry the publisher edits moves to the end. The year archive
has one term per collection year from 1956 to 2026 and one for the Vážný
volumes; 1971 runs to 22 pages.

## The detail page

`<h1>`: type, court, date, docket and, for most entries, ECLI ("Rozsudek
Nejvyššího soudu SSR ze dne 14.10.1970, sp. zn. 6 Cz 90/70,
ECLI:CZ:NS:1970:6.CZ.90.1970.1"). The docket marker is `sp. zn.` or `sen. zn.`
and a few interwar headings leave it out. The breadcrumb names the year and
issue. `table.content-table` holds one row per labelled field, then an
unlabelled row headed "Sbírkový text rozhodnutí" with the text as HTML.

Every label the research copy states, and its fate:

| Label                    | Stored as                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Právní věta              | headnote (`legalSentence` text field) and the collection entry                                                                                                                                                                |
| Anotace                  | abstract text field (stanoviska)                                                                                                                                                                                              |
| Soud                     | the row's court through `czDecisionCourt`: the ECLI's court code where it names one, else this row; the row's own spelling stays in the entry (the page's tooltip says it is normalised for search and may differ from print) |
| Datum rozhodnutí         | decision date                                                                                                                                                                                                                 |
| Spisová značka           | docket, through the CZE grammar where it reads one, else as stated                                                                                                                                                            |
| Číslo rozhodnutí         | entry `number` (text: some are Roman numerals)                                                                                                                                                                                |
| Rok                      | entry `year`                                                                                                                                                                                                                  |
| Sešit                    | entry `issue` (`1`, `1-2`, `9-10`)                                                                                                                                                                                            |
| Typ rozhodnutí           | decision type, lowercased                                                                                                                                                                                                     |
| Heslo                    | entry `keywords`, one per chip the page prints (the row joins them with ", ", which some keywords contain)                                                                                                                    |
| Předpisy                 | entry `citedProvisions`, one per printed line                                                                                                                                                                                 |
| Druh                     | entry `kind`, and `part` where it names the civil or criminal series                                                                                                                                                          |
| Dotčená rozhodnutí       | entry `affectedDecisions`, one per decision named (the earlier entries this one bears on)                                                                                                                                     |
| Ústavní stížnost         | entry `constitutionalComplaint`, as stated                                                                                                                                                                                    |
| Sbírkový text rozhodnutí | the document                                                                                                                                                                                                                  |

Anotace, Dotčená rozhodnutí and Ústavní stížnost sit in a second table below
the main one (`.detail-section__hidden`), stated by some entries only. The
annotation carries a tooltip saying it is not the court's binding opinion.

The page also prints the entry number again beside the export links and the
keywords as chips; both restate rows above.

Where a page states no row for the docket, date, type or court, the heading
answers; year and issue fall back to the breadcrumb. About one page in a
hundred states only Heslo and Předpisy. The stated row wins over the heading
when both exist and disagree: post 4320's heading dates it 14.01.2020, its
row 14.01.2022, and the row is stored with the heading kept whole.

Text: the cell's own heading ("Sbírkový text rozhodnutí") opens the document
as the publisher's heading; a centred paragraph set wholly in bold is a
heading ("Z odůvodnění:"); the paragraphs set wholly in italics that open the
text are the editors' summary of the case's history, kept as publisher
apparatus (an italic paragraph after the court's words began is its own
emphasis); numbered paragraphs ("1. Žalobou …") carry their number. One entry (post 6305) serves an empty
text cell and is stored without a document.

## Identity

The post id is the document id. The ECLI is stored as the heading states it.
For many entries that spelling differs from the court database's: a four-digit
docket year (`…1548.1997.1` where the database has `…1548.97.1`) and `NSČR`
with its diacritic. No stage of the pipeline canonicalises such spellings, so
the manifest declares the stated ECLI as no cross-source identity.

Reporter citations come from `czNsCollectionIdentifierValues`: `Rc 9/1971`
and `R 9/1971` for a civil entry, `Rt …` and `R …` for a criminal one, and
only the part-less `R n/year` for a stanovisko, whose `Druh` names no part. An
entry with no number, or a Roman one, carries none.

Language: the stopwords of the two languages counted over the headnote and
the text; Slovak where its hits outnumber Czech, else Czech. Over the research
copy this set Slovak on Nejvyšší soud SSR and SR entries and on part of the
federal courts' and of the Supreme Court's own pre-1960 entries, as the texts
read.

## Pace and walk

One request a second (gate `nsoud-sbirka-cz`). A crawl page reads the sitemap
index, the sitemap its cursor sits in, and up to twenty detail pages. A full
first walk is about 9,832 detail pages plus some 500 sitemap reads: under three
hours. At the newest entry a cycle costs two requests.

A 429 stops the source after one request. A detail page that could not be
read fails the cycle with the cursor unchanged; one the publisher no longer
serves (404, 410) is skipped.

## Validation over the whole archive

Every one of the 9,832 detail pages in the research copy (a 1 request/s crawl
of the sitemaps' entries on 2026-11-18) builds a decision. Labels stated:
Právní věta 9,624, Soud 9,639, Datum rozhodnutí 9,636, Spisová značka 9,637,
Číslo rozhodnutí and Rok 9,633, Sešit 9,588, Typ rozhodnutí 9,630, Heslo
9,566, Předpisy 8,959, Druh 9,595, Anotace 1,553, Dotčená rozhodnutí 245,
Ústavní stížnost 57; no other label appears. 814 entries state no ECLI; 250
carry no reporter citation (no number, or a Roman one); 223 dockets are kept
as stated (interwar `Kr I 4/19`, `25 Co 498, 499/97`); one entry (post 24011,
a plenary directive) states no docket at all and is labelled by its post id
as a placeholder. Four entries (posts 5025, 6304, 6305, 6306) serve an empty
text cell. 1,182 entries read as Slovak.

Decision types stated: rozsudek, usnesení, rozhodnutí, stanovisko, nález,
zpráva, zhodnocení, závěry, výtah z materiálu, zásady, směrnice, the grand
chamber's rozsudek and usnesení velkého senátu, průzkum, rozbor a jiné
materiály, three misspellings (rozhodutí, rozhodnurí, rozsudek.) and one
docket in the type row (Cz 509/56), which is not read as a type.

## Coverage

Earliest decision date the collection states: 1918-09-30 (post 22718, a Vážný
entry whose heading dates it 30. 1. 1919; the row is stored). The manifest
declares decision dates from then.
