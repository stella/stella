# Plan: Gotenberg PDF Conversion & File Table Removal

Date: 2026-02-21

## Goal

Remove the `files` table and inline file metadata into the
`fields` JSONB `content` column. Add Gotenberg-based PDF
conversion so non-PDF uploads are automatically converted for
AI processing. Users always download the original (source)
file; AI workflows use the converted PDF.

## Design Decisions

- **Inline file data into `FieldContent` instead of a
  separate table.** The `files` table was a thin wrapper
  around S3 metadata. Inlining it into the `content` JSONB
  eliminates a join, simplifies the delete path (no restrict
  FK dance), and co-locates file identity with field identity.
  S3 keys are derived from the file IDs stored in `content`.

- **`pdfFileId` as an optional field on file content, not a
  separate column.** When a non-PDF file is uploaded, the
  converted PDF gets its own S3 object with a separate
  nanoid. The `pdfFileId` lives inside the `content` JSONB
  alongside the source file metadata. This keeps the schema
  flat: one content object has everything the system needs to
  find both the original and the converted file.

- **Conversion happens concurrently with S3 upload.** After
  buffering the uploaded file, two operations run in parallel:
  (1) upload the original to S3, (2) send to Gotenberg for
  conversion. If Gotenberg fails, the upload still succeeds
  (file is stored, just not convertible for AI). The
  `pdfFileId` is only set when conversion succeeds.

- **Gotenberg over embedded LibreOffice.** Gotenberg is a
  stateless HTTP service with a well-defined API, health
  checks, and resource isolation. Running LibreOffice
  in-process would be fragile and non-scalable.

- **Justifications reference `fieldId` (not `fileId`).** With
  the `files` table gone, justifications FK to `fields.id`
  with a constraint that the field must be of type `"file"`.
  The justification's bounding boxes are always relative to
  the PDF that AI processed (the converted file or the
  original if already PDF).

## Scope

**In scope:**

- Remove `files` table from schema
- Expand `FieldContent` type `"file"` with inline file
  metadata: `id`, `fileName`, `mimeType`, `sizeBytes`,
  `encrypted`, `sha256Hex`, and optional `pdfFile` object
  (`{ id, fileName, mimeType, sizeBytes, sha256Hex }`)
- Remove `fields.fileId` column (data moves into content)
- Update `justifications` to FK on `fields.id` instead of
  `files.id`; remove `justifications.fileId` column
- Add Gotenberg service to `docker-compose.yml`
- Add `GOTENBERG_URL` to `env.ts`
- Create Gotenberg client (`handlers/files/gotenberg.ts`)
  with a list of convertible MIME types (LibreOffice route)
- Update upload handler: parallel S3 upload + Gotenberg
  conversion for convertible files
- Update read handler: return presigned URL for source file
  (always), plus PDF presigned URL when `pdfFile` exists
- Update entity delete handler: delete both source and PDF
  S3 objects
- Update workspace delete handler: collect both file IDs
- Update AI workflow (`generate-batch.ts`,
  `generate-batch-shared.ts`): use `pdfFile.id` for S3 fetch
  when present, fall back to source file ID when source is
  already PDF
- Update `createFileKey` to accept the file's own mimeType
  (source) or always use `pdf` extension (for pdfFile)
- Update frontend `WorkspaceField` type to include new
  content shape
- Update frontend file display, download, and preview logic
- Update `readEntitiesHandler` to stop joining `files` table

**Out of scope:**

- Data migration (explicit requirement)
- Converting already-uploaded non-PDF files retroactively
- Retry/queue for failed conversions
- Thumbnail generation

## Implementation

### Schema (`apps/api/src/db/schema.ts`)

- Delete `files` table definition and all references
- Remove `fields.fileId` column
- Remove the `fields_file_id_v1_check` check constraint
- Remove `fields_file_id_idx` index
- Update `justifications`: remove `fileId` column, the FK
  on `fieldId` already exists and cascades
- Remove `files` from `defineRelations`; update `fields`
  relations to remove `file`; update `justifications`
  relations to remove `file`

### Schema validators

(`apps/api/src/db/schema-validators.ts`)

- Expand the `type: "file"` variant of `fieldContentSchema`:
  ```
  {
    version: 1,
    type: "file",
    id: string,        // nanoid, S3 key source
    fileName: string,
    mimeType: string,
    sizeBytes: integer,
    encrypted: boolean,
    sha256Hex: string,
    pdfFile: nullable({
      id: string,      // nanoid, S3 key for PDF
      fileName: string,  // e.g. "contract.pdf"
      mimeType: "application/pdf",
      sizeBytes: integer,
      sha256Hex: string,
    })
  }
  ```

### Gotenberg client

(`apps/api/src/handlers/files/gotenberg.ts`)

- `CONVERTIBLE_MIME_TYPES` constant: full list of MIME types
  Gotenberg's LibreOffice route supports (doc, docx, xls,
  xlsx, ppt, pptx, odt, ods, odp, rtf, txt, csv, html,
  etc.)
- `convertToPdf(fileBuffer, fileName)` function: POST
  multipart to `${GOTENBERG_URL}/forms/libreoffice/convert`,
  return `Result<ArrayBuffer, GotenbergError>`
- `isConvertibleMimeType(mimeType)` type guard
- Timeout: 30s (AbortSignal.timeout)

### Environment (`apps/api/src/env.ts`)

- Add `GOTENBERG_URL: v.pipe(v.string(), v.url())`

### Docker Compose (`docker-compose.yml`)

- Add `gotenberg` service (profile: dev), image
  `gotenberg/gotenberg:8`, port 3003, health check on
  `/health`

### Upload handler

(`apps/api/src/handlers/entities/upload.ts`)

- After buffering file: run S3 upload and Gotenberg
  conversion in parallel (if convertible MIME type)
- Build `content` object with inline file metadata
- If conversion succeeds: set `pdfFile` with converted
  file's nanoid, size, sha256, and upload converted file
  to S3
- If conversion fails: `pdfFile` is null (file stored
  but not AI-processable)
- Remove `files` table insert from the transaction
- Insert field with full file content instead of bare
  `{ type: "file", version: 1 }`

### Read entities handler

(`apps/api/src/handlers/entities/read.ts`)

- Remove `with: { file: ... }` from query
- File metadata is already in `field.content`; return it
  directly without enrichment

### Read file handler

(`apps/api/src/handlers/files/read-by-id.ts`)

- Change to accept a file content object (or look up via
  field query) instead of querying the `files` table
- Generate presigned URL from content's `id` and `mimeType`
- The handler still needs org/workspace scoping for the
  S3 key

### Entity delete handler

(`apps/api/src/handlers/entities/delete.ts`)

- Query file metadata from `fields.content` (JSONB) instead
  of joining `files` table
- Collect both source file IDs and `pdfFile.id` values for
  S3 cleanup
- Remove `files` table delete from the transaction (cascade
  from entity → version → field handles everything)

### Workspace delete handler

(`apps/api/src/handlers/workspaces/delete-by-id.ts`)

- Query file IDs from `fields.content` JSONB instead of
  `files` table
- Collect both source and PDF file IDs for S3 cleanup
- Remove `files` table references

### AI workflow

(`apps/api/src/handlers/registry/actors/workflow/`)

- `generate-batch-shared.ts`: `resolveFiles` queries
  `fields.content` instead of `files` table; returns
  `pdfFile.id` when present, source `id` when mimeType
  is PDF
- `generate-batch.ts`: `fetchAndPrepareFiles` uses the
  resolved file ID (which is already the correct one for
  AI: either the converted PDF or the original PDF)
- `isAISupportedFile` check: a file is AI-supported when
  `content.mimeType === PDF_MIME_TYPE && !encrypted` OR
  when `content.pdfFile` is present

### File utilities (`apps/api/src/handlers/files/utils.ts`)

- `deleteS3Objects`: accept `{ fileId, mimeType }[]`
  (unchanged interface, callers now pass both source and
  PDF entries)
- `createFileKey`: unchanged (uses fileId + mimeType)

### Frontend types (`apps/web/src/lib/types.ts`)

- Update `WorkspaceField` file content type to match new
  shape (inline id, fileName, mimeType, sizeBytes,
  encrypted, pdfFile)

### Frontend components

- File cell: use `content.fileName` directly (no change
  in display, data source changes)
- File download: always use source file (`content.id`,
  `content.mimeType`)
- PDF viewer: use `content.pdfFile.id` when present,
  otherwise `content.id` (only when mimeType is PDF)
- `isViewableMimeType`: expand to return true when
  `pdfFile` is present (convertible files can be viewed
  as PDF)
- Upload hook: adjust response type (no separate `fileId`
  returned; entity contains file data in field content)

### Create entities handler

(`apps/api/src/handlers/entities/create.ts`)

- The `type: "file"` path currently passes `fileId` in the
  body. This needs rethinking since there's no `files` table
  to reference. The upload handler now creates the entity
  directly, so the two-step "upload file then create entity"
  flow collapses into the single upload handler.

## Test Cases

- Upload a PDF: stored as-is, no conversion, `pdfFile`
  is null, AI can process it
- Upload a DOCX: source stored in S3, Gotenberg converts
  to PDF, `pdfFile` populated, AI uses the PDF
- Upload an unsupported format (e.g., ZIP): stored as-is,
  no conversion attempted, `pdfFile` is null, AI marks
  as unsupported
- Upload a DOCX when Gotenberg is down: source stored, no
  `pdfFile`, AI marks as unsupported, no error to user
- Download always returns the source file (DOCX, not PDF)
- Delete entity: both source and PDF S3 objects cleaned up
- Delete workspace: all source and PDF S3 objects cleaned up
- AI workflow skips encrypted PDFs (unchanged)
- AI workflow uses `pdfFile` when available for non-PDF
  sources
- Justifications reference field ID correctly

## Open Questions

- Should we add a `convertedAt` timestamp to `pdfFile`
  for auditability?
- Should the frontend show a badge/indicator when a file
  has been converted (e.g., "DOCX -> PDF")?
- Should we expose a way to retry conversion for files
  where Gotenberg failed?
