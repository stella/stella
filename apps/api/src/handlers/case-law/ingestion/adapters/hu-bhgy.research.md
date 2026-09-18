# Bírósági Határozatok Gyűjteménye (BHGY) — source notes

What a maintainer needs to read `hu-bhgy.ts` and `parsers/hu-bhgy.ts`: the
shapes the publisher serves and the limits the constants in those files name.

Publisher: Országos Bírósági Hivatal, `https://eakta.birosag.hu`. Publication
and anonymisation rest on 2011. évi CLXI. törvény (Bszi.) 163–166. §.

## Listing

`POST /AnonimizaltHatarozat/Search?Area=`, form-encoded, with
`X-Requested-With: XMLHttpRequest`. No auth, no CSRF.

Response: `{ List: Row[] | null, Count: number, Success: boolean, Message: string | null }`.

- The no-results state is `{ List: [], Count: 0, Success: true, Message: null }`.
- `Success: false` carries a Hungarian message in `Message` and is a refusal,
  never an empty result.

Filters the adapter uses: `MeghozoBirosag` (court name), `Kollegium` (the five
colleges; multi-valued on a row, joined with `"; "`), `MeghozatalIdejeTol` /
`MeghozatalIdejeIg` (a year, not a date), `Rendezes` (`IndexelesIdejeNovekvo`,
`IndexelesIdejeCsokkeno`), `ResultCount` and `ResultStartIndex`.

Request limits are constants in `hu-bhgy.ts` rather than prose: `MAX_PAGE_SIZE`
caps a page, `SATURATION_COUNT` is the value `Count` reports for any query
matching at least that many rows and the offset the search refuses to pass. A
window reporting it cannot be walked to its end, so `listHuBhgySlicePage`
treats it as a failure rather than as a large window.

Row shape:

```json
{
  "Azonosito": "Gfv.30091/2025/4",
  "MeghozoBirosag": "Kúria",
  "Kollegium": "gazdasági",
  "JogTerulet": "gazdasági jog",
  "KapcsolodoHatarozatok": [
    { "KapcsolodoUgyszam": "Pfv.21067/2010/5", "KapcsolodoBirosag": "Kúria" }
  ],
  "Jogszabalyhelyek": "2013. évi V. törvény a Polgári Törvénykönyvről 3:17. § (6) - 2025-10-01;</br>…",
  "HatarozatEve": 2025,
  "Szoveg": null,
  "Rezume": "A közgyűlési meghívó …",
  "RezumeSzovegKornyezet": null,
  "EgyediAzonosito": "K-GJ-2025-179",
  "IndexelesIdeje": "2025-10-10T10:23:45.051584+02:00",
  "NemHivatkozhatoSzoveg": null,
  "IndexId": "3cca08de-ba20-4fdf-8366-ad1825f3f671",
  "DownloadLink": null
}
```

- `Azonosito` is the docket as the publisher stores it: registry letters,
  register number **without** the thousands dot and **without** the panel
  numeral (`Gfv.30091/2025/4`); the document prints the full form
  (`Gfv.VI.30.091/2025/4.`). Editorial series occupy the same field (`GK.34`,
  `EBH.2013.K.15.`, even `EBH..2013.K.32.` with a doubled dot); they are not
  court file references and `DECISION_DOCKET_GRAMMARS.HUN` rejects them.
- `EgyediAzonosito` is the BHGY identifier per 29/2007. (V. 31.) IRM rendelet:
  court code (`K` Kúria, `FIT`/`SZIT`/`PIT`/`DIT`/`GYIT` appellate courts,
  numeric codes for lower courts), legal-area code (`PJ`, `GJ`, `BJ`, `KJ`,
  `MJ`, `KBJ`, `SZJ`, `BVJ`), year, yearly serial.
- `IndexId` is a GUID for decisions published through the current system and a
  legacy key (`AHK4T__25228840`) for the 2020-09-29 migration of the older
  collection.
- `IndexelesIdeje` is the publication timestamp, written with the publisher's
  local UTC offset. Sorting by `IndexelesIdejeNovekvo` gives a publication-order
  walk that only ever appends. The publisher's clock runs ahead of real time, so
  the frontier is read off the rows rather than off our own clock, and it is
  compared as an instant (`huBhgyCoveredByFrontier`): the offset moves with
  daylight saving, and two timestamps across the switch sort one way as text and
  the other way in time.
- `Jogszabalyhelyek` is a `</br>`-joined list of the provisions the publisher
  tagged: `<year>. évi <Roman>. törvény <title> <section>. § (<subsection>)`
  optionally followed by ` - <ISO date>`. Decrees appear as
  `15/1990. BM rendelet`.
- `KapcsolodoHatarozatok` lists the other instances of the same case, with their
  court.
- **No decision date in the row.** `HatarozatEve` is the year only, and it does
  not always agree with the docket's year; the date is in the text
  (`Budapest, 2025. október 1.`, or `Budapest, 2024.05.06.`).
- **No ECLI anywhere.** Hungary does not issue ECLI.

## Documents

Both unauthenticated `GET`, both keyed by `IndexId`:

- `/hatarozat-letoltes/?birosagName=<court>&ugyszam=<Azonosito>&azonosito=<IndexId>`
  returns the source file:
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document` for
  decisions born in the current system, `application/rtf` for the migrated
  legacy collection. This is the surface the adapter records as the `document`
  envelope part.
- `/anonimizalt-hatarozat-pdf/?…` returns a PDF rendition of the same file.

Stable public deep link:
`/anonimizalt-hatarozatok?azonosito=<Azonosito>&birosag=<court>` — the
collection's own search page, addressed by two fields of the row.

### Current era (DOCX)

Word packages with **no styles, no bold, no italic, no colour, no highlight, no
tables and no footnotes**: every heading is a plain paragraph, `w:jc` is `left`
or `both` throughout, and each paragraph ends with a `w:br`. Section roles can
only be read off the wording and the position.

```
A Kúria
mint felülvizsgálati bíróság
végzés
Az ügy száma:      Gfv.VI.30.091/2025/4.
A tanács tagjai: Dr. … a tanács elnöke / Dr. … előadó bíró / …
A felperes: név1 (cím1)
A felperes képviselője: … Ügyvédi Iroda
Az alperesek: cég1 (cím3)
A per tárgya: …
A felülvizsgálati kérelmet benyújtó fél: alperesek
A másodfokú bíróság neve és a jogerős határozat száma: …
Az elsőfokú bíróság neve és a határozat száma: …
Rendelkező rész
…
Indokolás
[1] …
Budapest, 2025. október 1.
Dr. … s.k. a tanács elnöke, …
A kiadmány hiteléül:
```

The third title line is the decision kind in the nominative; the operative part
opens with `Rendelkező rész`, never with a bare nominative, which is why
`OPERATIVE_INTRODUCTIONS` holds accusative forms only.

A labelled line runs over as many lines as its value needs — one per judge of
the bench, one per defendant, the court below on the line after its own label —
so `HEADER_LABELS` carries its role to the unlabelled lines beneath it. The same
label is printed for one party and for several (`Az alperes:`,
`Az alperesek képviselője:`), so a match is the longest form that opens the line.

An anonymisation placeholder is its own `w:r`, with the same formatting as the
runs around it: the run split isolates the token but marks nothing.

### Legacy era (RTF, migrated 2020-09-29)

A small RTF dialect:

- header groups `\fonttbl`, `\colortbl`, `\stylesheet`, and `\*` destinations;
- `\ansicpg1250` and `\ansicpg1252` both occur, with `\'xx` bytes and `\uN?`;
- paragraphs `\par`, resets `\pard`, alignment `\qj`/`\qc`, `\tab`, `\line`;
- character state `\b`/`\b0`, `\i`/`\i0`, `\ul`/`\ulnone`, `\cfN`, `\fsN`,
  `\fN`, `\sN`, `\keepn`, `\hyphpar`, `\txN`, `\lang`.

Anonymised spans are set in a colour (`\cf2`, `\cf3`) whose `\colortbl` entry is
plain black, so the colour is a marker rather than a rendering instruction.

The writer omits the delimiter after a control word in the signature block:
`\tabDr.Kovács Tamás sk.` is `\tab` followed by the text `Dr.Kovács Tamás sk.`,
and a reader that takes the longest alphabetic run as the control word swallows
the `Dr`.

Legacy documents print no labelled header and no `[n]` paragraph numbering, set
the decision kind as spaced capitals (`Í T É L E T E T :`), and spell their
placeholders out (`alperes neve (címe)`, `Terhelt1 vádlott`,
`terhelt születési helye`). A lower-court attachment can be a non-court
document.

## Anonymisation

Placeholders are inline tokens: `név1`, `cím1`, `cég1`, `dátum1`, `Terhelt1`,
`Gyanúsított 1.`, `felperes2`, and the legacy spelled-out forms
`alperes neve`, `felperes neve`, `címe`, `város neve`,
`terhelt születési helye`. Judges, counsel and law firms are named;
Bszi. 166. § (2) keeps them.
