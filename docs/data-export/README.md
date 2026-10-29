# stella data export format, version 1

An organisation owner or admin can export what the organisation keeps in
stella through the `data-exports.*` capabilities (API, MCP and CLI). The
export is a set of ZIP parts plus one export manifest.

Scope: every client matter of the organisation with its folders, documents
(all live versions, or only current ones), tasks, time entries and
invoices, and the organisation's contacts, clauses, templates and time
entries without a matter. Not included: personal matters (matters without
a client, which belong to one member), deleted document versions, `link`
entities, and custom property values. This page describes the format; the machine-readable
contract is [`stella-data-export.v1.schema.json`](./stella-data-export.v1.schema.json),
generated from `apps/api/src/handlers/data-exports/manifest-schema.ts`
(`bun apps/api/scripts/generate-data-export-schema.ts`).

## Files

| File                                   | What it holds                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `export-manifest.json`                 | `kind: "export"`: every part with its file name, size, SHA-256 and matter ids; totals; files that need attention (`problems`). |
| `stella-export-<id>-part-NN-of-MM.zip` | One part. Parts target about 2 GiB and split only between matters, so every part is usable on its own.                         |

Inside each part:

```
manifest.json                       kind: "part"; everything in this part
README.txt
organization/                       part 1 only
  contacts.json / .csv
  contact-relationships.json / .csv
  clauses.json / .csv               JSON carries versions and variants
  templates.json / .csv             JSON carries versions
  invoices-without-matter.json / .csv  client invoices with lines, payments and expenses
  time-entries-without-matter.json / .csv
  templates/<name>/<file> (v<n>).<ext>
matters/<matter name> [<reference>]/
  matter.json                       with linked contacts and their roles
  tasks.json / .csv                 JSON carries assignees
  time-entries.json / .csv
  invoices.json / .csv              JSON carries invoice lines, payments and expenses
  documents/<folders>/<file>        current version of each document
  versions/<folders>/<file> (v<n>).<ext>   earlier versions
```

## Rules an importer can rely on

- Identity is the id, never the path. Every matter, folder, document, version
  and file carries its stella UUID; records refer to each other by id.
- Every file listed in a manifest is in the same part, at `path`, with the
  listed `sizeBytes` and `sha256` (lowercase hex, of the bytes in the
  archive). `problems` lists files that need attention: `missing` and
  `fetch_failed` files are not in the archive; a `checksum_mismatch` file is
  in the archive as stored, and `recordedSha256` is the checksum recorded
  when it was uploaded. A `matter_unavailable` entry names a matter that
  was planned for the part but could no longer be read when the part was
  built (deleted, or no longer visible); none of it is in the archive.
- `documents[].currentVersionId` names the current version; `versions` is
  ordered by `versionNumber` and excludes deleted versions. With
  `scope.versions: "current"` only the current version is present.
- JSON record files are arrays of objects, one per stored row, with
  camelCase keys, ISO 8601 UTC timestamps, dates as `YYYY-MM-DD`, and money
  as integer minor units next to a `currency`. JSON is canonical.
- CSV files are UTF-8 with a byte order mark and CRLF line ends. A cell that
  starts with `=`, `+`, `-`, `@`, a tab or a line break is prefixed with a tab
  so spreadsheets do not run it as a formula; read the JSON for exact values.
- Paths are NFC-normalised UTF-8 (the ZIP UTF-8 flag is set on every entry),
  free of control characters and Windows device names, and unique under case
  folding, so a part extracts without collisions on any common file system.
  A clashing name gets ` (2)`, ` (3)`, ... before its extension.
- Already-compressed files (PDF, Office Open XML, images, archives) and
  any file over 8 MiB are stored; smaller text, JSON and CSV are deflated.
  Stored document files are streamed into the archive, so their entries use
  a data descriptor (flag bit 3) after the data; read parts through the
  central directory (every desktop unzip tool does). ZIP64 records appear
  only where a size, offset or entry count needs them.

## Versioning

`format` is `stella-data-export`; `formatVersion` is an integer. The schema
rejects unknown manifest fields, so any change to the manifest's shape
increments `formatVersion` and adds a new schema file next to this one.
Columns inside JSON record files may grow within a version; an importer
should ignore keys it does not know there.
