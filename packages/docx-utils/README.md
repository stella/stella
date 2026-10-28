# @stll/docx-utils

Low-level helpers for OOXML packages: relationships and content types,
attached-template handling, office format metadata, and the namespace
constants those operations need. Read and write the archives themselves with
`@stll/docx-core/zip`.

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

## License

Apache-2.0
