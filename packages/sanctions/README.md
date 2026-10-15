# @stll/sanctions

Sanctions-list parsing and name screening. Pure library: no network, no
storage; callers fetch the lists and keep the index. `SANCTIONS_SOURCES` gives
each list's issuer, official download location, reuse terms, and a cheap
edition check. Each entry carries its issuer; callers decide the legal effect
of a hit in their jurisdiction.

Fetch the URL in `editionMarker` with HEAD for `http-last-modified`, or GET
for the other strategies, then pass its header or small response body to
`readSourceEditionMarker(source, response)`. The returned opaque value can be
compared with the last poll. For the Czech dated file, the result also gives
the current direct CSV URL. A missing or changed publisher marker returns an
error rather than treating the list as unchanged.
The Commission endpoints require the caller's FSF portal token as the `token`
query parameter; the registry records this access requirement without storing
a credential.

## Lists

| Source                                   | Official publication                                                                                                                    | Parser                                | Edition stamp                    | Cheap edition check                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| EU consolidated financial sanctions list | [Commission XML 1.1](https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content)                                | `parseEuList(stream)`                 | `generationDate`, `globalFileId` | Publisher checksum endpoint                                                                              |
| UN Security Council consolidated list    | [UN XML](https://scsanctions.un.org/resources/xml/en/consolidated.xml)                                                                  | `parseUnList(stream)`                 | `dateGenerated`                  | [Official list page](https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list) update date |
| Czech national sanctions list            | [MFA publication page](https://mzv.gov.cz/jnp/cz/zahranicni_vztahy/sankcni_politika/sankcni_seznam_cr/vnitrostatni_sankcni_seznam.html) | `parseCzList({ csv, fileNameOrUrl })` | date in the file name            | Dated CSV link on the publication page                                                                   |
| US OFAC SDN                              | [SLS SDN XML](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML)                                       | `parseOfacList("us-sdn", stream)`     | `Publish_Date`                   | HTTP HEAD `Last-Modified`                                                                                |
| US OFAC consolidated non-SDN             | [SLS consolidated XML](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML)                     | `parseOfacList("us-non-sdn", stream)` | `Publish_Date`                   | HTTP HEAD `Last-Modified`                                                                                |
| UK Sanctions List                        | [FCDO XML](https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml)                                                                | `parseUkList(stream)`                 | `DateGenerated`                  | HTTP HEAD `Last-Modified`                                                                                |
| Swiss SECO consolidated list             | [SECO XML](https://www.seco.admin.ch/en/searching-for-subjects-sanctions)                                                               | `parseSecoList(stream)`               | root `date`                      | HTTP HEAD `Content-Disposition` filename                                                                 |

Every parser returns a `Result`: the complete list or a
`SanctionsListParseError`, never the entries read before a problem. The XML
parsers stream, so the 26 MB EU file never sits in memory as text.
`readEuListVersion` and `readUnListVersion` read the edition stamp and stop.
The Czech CSV keeps revoked and superseded rows as history; only rows in force
become entries. OFAC's [standard XML](https://ofac.treasury.gov/sdn-list-data-formats-data-schemas/frequently-asked-questions-on-advanced-sanctions-list-standard) carries the core records inside each `sdnEntry`; the advanced XML links records across separate sections, so standard XML allows bounded streaming. The OFAC parser keeps every name, birth date, nationality or citizenship, identification row, address and programme in the entry shape. Several programme tags are joined with `; ` in `programme`. Dates with bounded day or month ranges become inclusive year ranges, the precision supported by the entry model. Unknown source types and alias quality are explicit `unknown` values. OFAC also uses `idList` for non-identity facts, such as gender and website; these retain their original label and value with identifier kind `unknown` and cannot trigger a decisive identifier match. OFAC [requires a User-Agent](https://ofac.treasury.gov/sdn-list-data-formats-data-schemas/ofac-technical-actions-in-reverse-chronological-order/20240516_44) on automated downloads.

A parse proves a file well formed, not complete. Before a new edition replaces
the one in use, `checkListReplacement({ previous, next })` refuses a first
edition below the source's minimum and an edition that shrank more than the
source's policy allows.

The [UK Sanctions List](https://www.gov.uk/government/publications/the-uk-sanctions-list)
is the UK's official list. Its XML distinguishes individuals, entities and ships;
the parser keeps names and alias strengths, partial birth dates, nationalities,
identifiers, addresses and regime names. A date with an unknown day or month
keeps only the stated precision.

The [SECO consolidated XML](https://www.seco.admin.ch/en/searching-for-subjects-sanctions)
includes delisted history. `parseSecoList` keeps currently listed targets,
resolves their programme and place references, and retains the source's name
variants and partial birth dates. Its dated download filename is available in
the `Content-Disposition` header of an HTTP HEAD response.

## Screening

```ts
const index = buildScreeningIndex([eu, un, cz]);
const result = screen(
  index,
  { name: "Vladimir Putin", entityType: "person", birthDate: { year: 1952 } },
  { cutoff: DEFAULT_CUTOFF },
);
```

`screen` returns every entry scoring at or above the cutoff as a possible
match for human review, with the evidence per field. Names match regardless of
word order, diacritics, Cyrillic or Latin script, transcription conventions,
legal forms, omitted middle names and small typos. A matching identifier is
decisive unless the list marks the document false; birth date, nationality and
entity type raise or lower the score. A near-exact name whose client fields
contradict the listing stays reported at the cutoff, with the conflicts named
in its evidence. `totalMatches` and `truncated` say when the limit cut results.

Free-text queries may contain at most 24 normalized tokens before
deduplication. Excess input returns `excess-query-tokens`; register-resolved
names bypass this input cap because callers cannot correct a publisher's name.
Repeated query and alias spellings retain their original adjacency graph.

An optimistic score filters alias groups only when their upper bound cannot
reach the cutoff. Every remaining group receives full alignment, with exact
groups first; equivalent aliases share a score and results stay grouped by entry.
Each folded and raw vocabulary has a symmetric-deletion index: every spelling
is indexed under hashes of all distinct deletions through its edit budget (zero below
four characters, one for four or five, two otherwise). Append-only numeric pairs sort and pack by hash shard, avoiding a mutable map
and linked node for every deletion. Query deletions union
postings, then exact Damerau–Levenshtein verifies every candidate (including hash collisions). There is no
neighbour or alias-pattern cap. Index construction and posting packing remain
incremental. The old bigram/histogram candidate path and similarity cache are gone.

`screening-work-bound.ts` derives a defensive work invariant from the edition
and prepared input, independently of candidate order. For normalized token
length L there are at most D=1+L+L(L−1)/2 deletion keys. With V vocabulary
spellings of maximum length M, lookup costs at most
(L+1)(D+1)+DV+V·max(1,LM): each posting and neighbour count is bounded by V.
For T query tokens and J original adjacent pairs, U=T+J; both spelling forms
are covered. The bound also covers all alias postings, every alias's full
pair alignment and sorting, identity evidence, identifiers and result sorting.
The implementation derives these edition dimensions during the incremental
build. It uses actual validated input lengths, including register-resolved
names. The public contract caps organisation names at 512 characters and person
name parts at 100 each; the free-text token ceiling remains 24.

Exhausting this bound is an invariant failure: `ScreeningWorkLimitError`
(`work-limit`) propagates to the API's reported, typed `incomplete` list status.
Callers may supply a smaller budget for failure-path tests. `truncated` still
marks a returned-match limit: `totalMatches` is the exact total after all
candidate scoring completes. API completion metrics count these fully scored
shortlists as complete; only the typed incomplete result counts as incomplete.
Unavailable lists retain failure metrics and emit no completion metric.

The shared API service yields to the event loop between list screenings;
anonymous screenings additionally allow at most two active requests per API
process and reject excess work before database reads. The work budget is a
backstop, not a wall-clock deadline. Public matching uses a bounded worker-thread
pool (one worker by default, at most two), with indexes built and cached in the
worker. Its 250 ms total screening deadline includes queueing and database reads;
expiry or a worker crash reports unavailable and recycles the worker. Large cold
editions are rebuilt without identity input in a bounded two-minute background
lease after expiry. Edition changes replace the worker cache on the next check.
The product path retains its existing cache. Both paths use the derived work invariant.

## Evaluation

```sh
bun run evaluate -- --eu <eu.xml> --un <un.xml> --cz <cz.csv>
```

Builds positives (held-out aliases and perturbed listed names) and negatives
(common names that are not listed, listed names with another birth date) from
the lists and reports precision and recall per cutoff. Without paths it runs
on the checked-in excerpts; `--write-sample` regenerates the sample the tests
replay.

## License

The library code is Apache-2.0. Source data has separate terms:

| Data                                                                                                                                                    | Reuse terms                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [EU Commission list](https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions?locale=en) | [Commission reuse decision 2011/833/EU](https://eur-lex.europa.eu/eli/dec/2011/833/oj/eng) for the XML 1.1 distribution                                              |
| [UN Security Council list](https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list)                                                      | [UN website terms](https://www.un.org/Depts/los/LEGISLATIONANDTREATIES/terms_and_conditions.htm).                                                                    |
| [Czech MFA list](https://mzv.gov.cz/jnp/cz/o_ministerstvu/otevrena_data/index_5.html)                                                                   | Published on the [MFA open data page](https://mzv.gov.cz/jnp/cz/o_ministerstvu/otevrena_data/index_5.html).                                                          |
| [US OFAC lists](https://ofac.treasury.gov/sanctions-list-service)                                                                                       | US federal government work is [public domain under 17 USC § 105](https://www.govinfo.gov/content/pkg/USCODE-2024-title17/html/USCODE-2024-title17-chap1-sec105.htm). |
| [UK Sanctions List](https://www.gov.uk/government/publications/the-uk-sanctions-list)                                                                   | Terms are on the [publication page](https://www.gov.uk/government/publications/the-uk-sanctions-list).                                                               |
| [Swiss SECO list](https://www.seco.admin.ch/en/searching-for-subjects-sanctions)                                                                        | Terms are on the [federal terms page](https://www.admin.ch/en/terms-and-conditions).                                                                                 |

## Optional real-edition proof

`bun run prove:real-editions` downloads current public publisher editions with
the existing source metadata and parsers; `--directory` accepts previously
downloaded official editions. The nightly/on-demand full-test workflow runs it
outside PR checks. It measures build time, retained/peak process RSS, work,
observed neighbourhood size and p99 screening latency over common names across
scripts and organisations, with every list screened without a result cap.
The proof requires all sources; publisher failures are reported rather than
substituted with fixtures.
