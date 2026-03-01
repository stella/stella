# Plan: Accept Unsupported File Formats

Date: 2026-02-15
Issue: #93

## Goal

Allow users to upload any file format into a workspace table.
Unsupported formats (anything except PDF, for now) still appear as
rows but are visually distinguished and excluded from AI extraction.
Users can manually edit cell metadata for these rows (#24).

## Design Decisions

- **Replace `fileMimeTypeEnum` with `varchar`.**
  Postgres enums are rigid (ALTER TYPE ADD VALUE, no removal). Since
  we now accept arbitrary MIME types, a plain varchar with
  application-level validation is the right fit. The column stays
  NOT NULL; we validate format at the API boundary.

- **Keep `supportedMimeTypes` as the "extractable" list.**
  `supportedMimeTypes` continues to define which formats the AI
  workflow can process. Everything else is accepted for storage and
  display but skipped during extraction. This is a single source of
  truth for "can the AI read this file?"

- **Generic file icon + visual indicator for unsupported formats.**
  The `DocumentIcon` component already has a fallback `<File />`
  icon (lucide). Unsupported files use this fallback. The `FileCell`
  component should show a muted/greyed style and link to a download
  rather than the PDF viewer.

- **No blocklist of dangerous MIME types.**
  S3 stores files as opaque blobs with `acl: private`; they are
  never served directly to browsers or executed server-side. The
  presigned URLs are short-lived (30s) and access is auth-gated.
  A MIME type blocklist is trivially bypassed (wrong Content-Type
  header, renamed extension) and provides a false sense of
  security. If malware storage becomes a concern, ClamAV scanning
  on upload is the effective control. The existing 5 MB size limit
  serves as a practical guard.

- **New `"unsupported"` field content status.**
  AI extraction fields for unsupported files use a dedicated
  `"unsupported"` status rather than reusing `"error"`.
  `"error"` means "extraction was attempted and failed" (implies
  a retry might help); `"unsupported"` means "this file format
  cannot be processed" (permanent, no retry). The UI renders
  "Format not supported" instead of "Errored", which is clearer
  for users who intentionally uploaded a non-PDF file.

- **S3 key extension derived from MIME type, with fallback.**
  Extend `createFileKey` to map common MIME types to extensions via
  a lookup, falling back to `"bin"` for unknown types. This keeps
  S3 keys human-readable without requiring an exhaustive map.

## Scope

**In scope:**

- Accept any file MIME type for upload (frontend + backend)
- Store files in S3 and DB regardless of format
- Display unsupported files as rows with a visual distinction
- Skip AI extraction for unsupported formats
- Download action for unsupported files (instead of PDF viewer)

**Out of scope:**

- Rendering/previewing non-PDF formats (DOCX viewer, image
  preview, etc.)
- Adding new formats to the "extractable" list (future work)
- Manual cell metadata editing UI (covered by #24)
- File type blocklist/allowlist for security (evaluate later)

## Implementation

### DB schema change

- `apps/api/src/db/schema.ts` — replace `fileMimeTypeEnum` with a
  plain `varchar` column on the `files` table. Drop the enum type
  in a migration.

### Backend (API)

- `apps/api/src/handlers/files/schemas.ts` — change `mimeType` in
  `createFileBodySchema` from `t.UnionEnum(supportedMimeTypes)` to
  `t.String()` (with reasonable length constraint). Keep
  `supportedMimeTypes` exported for use as the extractable check.

- `apps/api/src/handlers/files/utils.ts` — extend
  `fileExtensionMap` to cover common types and add a fallback.
  Change the type signature to accept `string` instead of
  `SupportedMimeType`.

- `apps/api/src/handlers/files/presign.ts` — the presigned POST
  condition `{ "Content-Type": body.mimeType }` already uses the
  body value dynamically, so this works for any MIME type without
  changes beyond accepting the new schema.

- `apps/api/src/handlers/files/read-by-id.ts` — return the stored
  `mimeType` (already does this). No changes needed.

- `apps/api/src/handlers/files/create.ts` — no changes beyond what
  the schema change covers.

### AI workflow

- `apps/api/src/db/schema-validators.ts` — add `"unsupported"` to
  `fieldContentSchema` as a new literal type.

- `apps/api/src/handlers/registry/actors/workflow/generate-batch-shared.ts`
  and `generate-batch.ts` — when collecting `fileIds` for AI
  processing, check the file's MIME type against
  `supportedMimeTypes`. Skip files with unsupported types. If an
  entity has only unsupported files, mark its AI fields as
  `"unsupported"`.

### Frontend

- `apps/web/src/lib/types.ts` — keep `supportedMimeTypes` for the
  extractable check. Update `WorkspaceField`'s file content type
  to use `string` for `mimeType`. Add `"unsupported"` to the
  field content union type.

- `apps/web/src/routes/.../-components/files/consts.ts` — remove
  `PDF_MIME_TYPE` as the sole accepted type (or keep it as a
  convenience constant).

- `apps/web/src/routes/.../-components/files/mutations.ts` —
  remove the `mimeType !== PDF_MIME_TYPE` guard in
  `parseFileForUpload`. Update `UploadToS3Data` type to accept
  `string` for `mimeType`.

- `apps/web/src/routes/.../-hooks/use-create-file-entities.ts` —
  remove the `files.some((f) => f.type !== PDF_MIME_TYPE)` guard
  that rejects all files if any is non-PDF. Instead, upload all
  files.

- `apps/web/src/routes/.../-components/cell-result.tsx` — in
  `FileCell`, check whether the MIME type is in
  `supportedMimeTypes`. If not, render with a muted/greyed style
  and link to download instead of the PDF viewer route. Add an
  `"unsupported"` branch in `CellResult` that renders
  "Format not supported" (similar to how `"error"` renders
  "Errored").

- `apps/web/src/routes/.../-components/document-icon.tsx` — update
  `DocumentIconProps` to accept `string` for `mimeType` (the
  fallback `<File />` icon already handles unknown types).

## Test Cases

- Upload a PDF: should work exactly as before (row, AI extraction,
  PDF viewer link)
- Upload a DOCX: should appear as a row with generic file icon,
  greyed-out styling, no AI extraction triggered, download link
- Upload a mix of PDF + DOCX: all files appear as rows; PDFs get
  AI extraction, DOCX does not
- Drag-and-drop a folder with mixed formats: all accepted, correct
  visual distinction
- Duplicate detection still works for non-PDF files (SHA256-based)
- File size limits still enforced for non-PDF files
- AI workflow skips entities whose only file is unsupported and
  marks their AI fields as `"unsupported"` (not `"error"`)
- `CellResult` renders "Format not supported" for `"unsupported"`
  fields (distinct from "Errored")
