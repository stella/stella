# @stll/docx-utils

Low-level helpers for OOXML packages: relationships and content types,
attached-template handling, office format metadata, and the namespace
constants those operations need. Load bounded archives with `loadDocx` or
`loadDocxArchive`; write archives with `@stll/docx-core/zip`.

```ts
import { ensureRelationship, OOXML_NS } from "@stll/docx-utils";
```

## Install

```sh
bun add @stll/docx-utils
```

## Exports

- `OOXML_NS` / `OoxmlPrefix` — OOXML namespace constants and prefixes.
- `findNextRId`, `ensureContentType`, `ensureRelationship` — relationship and
  content-type management.
- `classifyAttachedTemplateTarget`, `sanitizeAttachedTemplateRelationships`,
  `sanitizeAttachedTemplateSource` — attached-template handling.

- `loadDocx`, `loadDocxArchive`, `DocxArchiveError` — shared bounded archive reads.
- `DOCX_MAX_ENTRIES`, `DOCX_MAX_ENTRY_BYTES`, `DOCX_MAX_TOTAL_BYTES` — archive limits.

## License

Apache-2.0
