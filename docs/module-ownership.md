# Module ownership

One capability, one owning module. This file is generated from
`scripts/ownership.ts`; edit the table there, not here, then run
`bun scripts/ownership.ts --write`.

Before adding a helper, module, or schema, look for the capability below and in
`packages/*`. Extend the owner, or say in the pull request why a second
implementation is correct.

Rows whose enforcement is not `none` are also read by the
`confine-owner/confine-owner` lint rule, which reports any linted file outside
the owner and its `allowed` list. Add a bypass by adding an `allowed` entry with a
reason, in the same table.

| Capability | Owner | Enforcement | Summary |
| --- | --- | --- | --- |
| `redis-client` — Valkey/Redis connections for ephemeral coordination | `apps/api/src/lib/redis-client.ts` | import `@/api/lib/redis-client` (plus 25 allowed files) | One module builds every Valkey client, so the uncapped reconnect ladder, the error classification, and the connection options hold for all of them. Valkey may carry only ephemeral coordination, and each allowed consumer states the degraded path it takes during an outage. |
| `clipboard-write` — Writing text to the system clipboard in the web client | `apps/web/src/lib/copy-to-clipboard.ts` | global `navigator.clipboard.writeText` | `navigator.clipboard.writeText` rejects on a denied permission or an insecure context, and every call site owes the user that outcome. The owner wraps it in a `Result`, so callers branch on the failure instead of each growing its own try/catch. `apps/landing` is outside the rule's reach, because oxlint does not scan `.astro` files, so its inline scripts keep their own clipboard writes. |
| `pagination-cursor-schema` — Cursor query fields on list endpoints | `apps/api/src/lib/custom-schema.ts` | none | Cursor query fields come from `tPaginationCursor`, so the byte cap is one named constant rather than a literal repeated per route. |
| `object-storage` — Object storage reads, writes, and presigned uploads | `apps/api/src/lib/s3.ts`, `apps/api/src/lib/s3-presign.ts` | none | `s3.ts` owns the cancellable transport, credential resolution, and response validation; `s3-presign.ts` owns the presigned PUT flow, which signs size and checksum headers Bun's client cannot. The `no-native-s3-object-read` and `no-native-s3-object-write` rules already enforce this boundary. |
| `transactional-email` — Transactional email templates and delivery | `apps/api/src/lib/email/smtp.ts`, `packages/transactional` | none | `smtp.ts` owns the transport, including the TLS requirement and the credential-pair validation. `@stll/transactional` owns the templates and their translations, so recipient-facing copy stays localized in one place. |
| `pdf-rendering` — Rendering an uploaded file to a PDF derivative | `apps/api/src/lib/files/gotenberg.ts` | none | One module talks to the conversion service, so the timeout, the spreadsheet fit-to-page pre-processing, and the derivative policy that decides which MIME types convert stay together. |
| `docx-model-compile` — Compiling a document model into DOCX bytes | `apps/api/src/handlers/entities/create-from-legal-source.ts`, `apps/api/src/handlers/chat/export/create-chat-export-docx.ts`, `apps/web/src/components/chat/create-document-compiler.ts` | none | The compiler itself is an external package; these are the in-repo entry points that drive it. Model compile serves drafts and exports: it builds a document from a model the caller already holds and never patches an existing template. |
| `docx-template-patch` — Rewriting OOXML parts inside an uploaded DOCX template | `apps/api/src/lib/docx/`, `packages/docx-utils/` | none | Template patching edits the parts of a file a user supplied, preserving everything it does not touch. It shares only the zip and namespace helpers with the model compiler. A third DOCX writer is not to be started. |
| `relative-time` — Relative and absolute time formatting in the web client | `apps/web/src/lib/relative-time.ts` | none | Relative-time output and the shared date/time format presets come from one module bound to the active formatting locale, so a rendered instant reads the same wherever it appears. The `require-relative-time-helpers` rule enforces it. |
| `money-arithmetic` — Monetary amounts and minor-unit arithmetic | `packages/money/` | none | Amounts are stored and computed in minor units behind a `CentsAmount` brand, so a major-unit value cannot be mixed into minor-unit math. The brand threads from the Drizzle column through the API boundary into the browser only while every producer mints it here. |
| `text-folding` — Diacritic and ASCII folding for search and slugs | `packages/text-normalize/` | none | Folding decides which strings compare equal, so search, highlighting, and slugs have to agree on it. Build slug helpers on the folds exported here rather than on a local regex. |
| `collation` — Locale-aware sorting of human-readable text | `apps/api/src/lib/collation.ts`, `apps/web/src/lib/collation.ts` | none | Constructing an `Intl.Collator` per comparison is a documented hot-path cost, so both sides cache them; `require-cached-collator` enforces that. The two modules are deliberate mirrors and are meant to converge into a shared package. |
