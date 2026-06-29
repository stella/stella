# @stll/docx-core

A typed OOXML/DOCX document model with parsing, validation, and serialization.

The package exposes a structured document model (paragraphs, runs, tables,
styles, section properties) together with the tools to produce and check DOCX
packages, plus a legal-source compiler that turns a plain legal draft into that
model or a finished DOCX file.

```ts
import { compileLegalSourceToDocx, validateDocxPackage } from "@stll/docx-core";

const { docx } = await compileLegalSourceToDocx(source);
const result = await validateDocxPackage(docx);
```

The document model types are also available from a dedicated subpath:

```ts
import type { Document, Paragraph, Run } from "@stll/docx-core/model";
```

## Install

```sh
bun add @stll/docx-core
```

## Exports

- `.` — the document model types, the legal-source compiler
  (`parseLegalSource`, `compileLegalSourceToDocument`,
  `compileLegalSourceToDocx`, `validateLegalDraft`), DOCX serialization
  (`serializeDocumentToDocx`), and validation (`validateDocxPackage`,
  `validateDocumentModel`, `assertValidDocumentModel`).
- `./model` — the document model types only.

## License

Apache-2.0
