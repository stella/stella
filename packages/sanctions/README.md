# @stll/sanctions

Sanctions-list parsing and name screening. Pure library: no network, no
storage; callers fetch the lists and keep the index.

## Lists

| Source                                         | Publication                             | Parser                                | Edition stamp                    |
| ---------------------------------------------- | --------------------------------------- | ------------------------------------- | -------------------------------- |
| EU consolidated financial sanctions list       | XML (schema 1.1)                        | `parseEuList(stream)`                 | `generationDate`, `globalFileId` |
| UN Security Council consolidated list          | XML                                     | `parseUnList(stream)`                 | `dateGenerated`                  |
| Czech national sanctions list (Act 1/2023 Sb.) | CSV in the national open data catalogue | `parseCzList({ csv, fileNameOrUrl })` | date in the file name            |

Every parser returns a `Result`: the complete list or a
`SanctionsListParseError`, never the entries read before a problem. The XML
parsers stream, so the 26 MB EU file never sits in memory as text.
`readEuListVersion` and `readUnListVersion` read the edition stamp and stop.
The Czech CSV keeps revoked and superseded rows as history; only rows in force
become entries.

A parse proves a file well formed, not complete. Before a new edition replaces
the one in use, `checkListReplacement({ previous, next })` refuses a first
edition below the source's minimum and an edition that shrank more than the
source's policy allows.

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

Apache-2.0
