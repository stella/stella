# @stll/docx-utils

Low-level helpers for reading and writing DOCX/OOXML zip packages.

The package wraps the mechanical parts of working with a DOCX file: loading and
repacking the underlying zip, extracting text or binary parts, managing
relationships and content types, and the OOXML namespace constants those
operations need.

```ts
import { loadDocx, extractText, ensureRelationship } from "@stll/docx-utils";

const zip = await loadDocx(bytes);
const text = await extractText(zip, "word/document.xml");
```

## Install

```sh
bun add @stll/docx-utils
```

## Exports

- `OOXML_NS` / `OoxmlPrefix` — OOXML namespace constants and prefixes.
- `loadDocx`, `repackZip`, `extractText`, `extractBinary`, `DOCX_COMPRESSION` —
  zip-level read and write helpers.
- `findNextRId`, `ensureContentType`, `ensureRelationship` — relationship and
  content-type management.

## License

Apache-2.0
