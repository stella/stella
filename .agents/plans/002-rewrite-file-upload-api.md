# Plan: Rewrite File Upload API

Date: 2026-02-16
Updated: 2026-02-19

## Goal

Replace the current presigned-URL upload flow with a proxy upload
through the backend. Restructure the data model so that versioning
happens at the entity level (entities → entityVersions → fields),
with files linked to fields. Add encrypted PDF detection at upload
time.

## Current Architecture

The schema already implements the target model:

```
workspaces (1)
  ├─ entities (many, cascade)
  │   ├─ currentVersionId → entityVersions
  │   └─ entityVersions (many, cascade)
  │       └─ fields (many, cascade)
  │           ├─ fileId → files (restrict)
  │           └─ content (JSONB: file | text | select | ...)
  ├─ properties (many, cascade)
  └─ files (many, cascade)

justifications
  ├─ fieldId → fields (cascade)
  └─ fileId → files (restrict)
```

Key points already in place:

- **`entities`** are the top-level versioned objects (not
  "documents"). Each entity has a `currentVersionId` pointing to
  its active `entityVersion`.
- **`entityVersions`** are immutable snapshots. A new version is
  created when an entity's fields change (designed for future
  rollback; currently one active version per entity).
- **`fields`** hold per-property values within an entity version.
  File-type fields carry a `fileId` FK (restrict delete) and
  `content: { version: 1, type: "file" }`.
- **`files`** store physical file metadata. S3 key is derived as
  `{organizationId}/{workspaceId}/{fileId}.{ext}`. Files have
  `encrypted` (boolean), `sha256Hex`, `sizeBytes`, `sourceFileId`
  (for derived files like Bates-numbered PDFs).
- **`justifications`** reference `fileId` directly (pinned to the
  physical file version analyzed by AI), not the entity or field.

There is **no `documents` or `document_versions` table**. The
entity/version/field system serves the same purpose: entities are
generic rows, and a file-type field value is the "document"
equivalent.

## Design Decisions

- **Proxy upload instead of presigned URLs**: files are sent
  directly to the backend, which validates, uploads to S3, and
  creates DB records in a single request. This enables synchronous
  validation (encrypted PDF check) and future conversion
  (DOCX to PDF) without a multi-step client flow.
- **S3 keys derived from file ID, not stored**: the S3 path is
  deterministically computed as
  `{organizationId}/{workspaceId}/{fileId}.{ext}`.
- **Entity-level versioning**: `entities` (logical record),
  `entityVersions` (revision history), `fields` (property values
  per version). Files are linked through fields, not directly on
  entities. This separates storage concerns from the data model
  and enables version restore without file copying.
- **Workspace-scoped content deduplication**: SHA-256 is computed
  server-side during upload. If an identical hash already exists
  for the same workspace, the upload is rejected as a duplicate.
  Index: `(workspaceId, sha256Hex)`.
- **Denormalized `currentVersionId` on entities**: avoids
  `ORDER BY created_at DESC LIMIT 1` on every entity read.
  Updated transactionally when a new version is created.
- **`encrypted` flag on files**: detected server-side during
  upload using `@libpdf/core`. Encrypted PDFs are treated as
  `unsupported` for AI workflows (same as non-PDF MIME types).
- **Cascade delete through entities/workspaces**: when an entity
  or workspace is deleted, associated entity versions, fields,
  and files are cleaned up. S3 objects are deleted before DB
  records (see S3 + DB transaction ordering in CLAUDE.md).
- **Max file size 50MB**: accommodates larger legal documents.
- **Split references — fields vs justifications**: `fields`
  references `fileId` (FK → files, restrict) — the field points
  to the physical file in that entity version. `justifications`
  also references `fileId` (FK → files, restrict) because
  justifications contain bounding boxes and Bates numbers tied
  to a specific file's page layout. If a new entity version is
  created with a different file, old justifications remain pinned
  to the file they were generated from; the workflow must re-run
  to produce new justifications.
- **File upload validation via `t.File`**: use Elysia's built-in
  `t.File` type for multipart schema validation. Enforce the 50MB
  cap via `t.File` options or post-validation check.

## Scope

**In scope:**

- Rewritten `files` table (nanoid PK, `organization_id`,
  `workspace_id`, `source_file_id` self-ref, `file_name`,
  `mime_type`, `size_bytes`, `encrypted`, `sha256_hex`,
  `created_at`)
- `entities` table with `current_version_id` (FK → entityVersions)
- `entityVersions` table (`entity_id` FK → entities, cascade)
- `fields` table with `file_id` (FK → files, restrict) and
  `content` JSONB
- Upload endpoint: `POST /entities/:workspaceId/upload` — accepts
  multipart file (via `t.File`), validates, checks workspace-scoped
  deduplication, detects encrypted PDFs, uploads to S3, creates
  file + entity + entityVersion + field records in a transaction
- Read endpoint: `GET /files/:workspaceId/url/:id` — resolves a
  file to a presigned download URL + metadata
- Encrypted PDF detection using `@libpdf/core`
- Frontend: replace the presigned URL upload flow with direct
  upload to the backend proxy
- Update AI workflow (`generate-batch.ts`) to work with the
  entity/version/field model
- S3 cleanup on entity delete and workspace delete
- Remove old presign and create-files handlers
- Clean slate: no data migration; `drizzle-kit push` from scratch

**Out of scope (deferred to DMS PR):**

- DOCX-to-PDF conversion via Gotenberg
- Entity version restore endpoint
- Standalone file/entity delete endpoint
- Full-text search indexing
- Matter lifecycle / archival

## Implementation

### 1. Database Schema

`apps/api/src/db/schema.ts` — already implemented:

- **`files` table**: nanoid PK, `organizationId`, `workspaceId`
  (FK → workspaces, cascade), `sourceFileId` (self-ref,
  nullable), `fileName`, `mimeType`, `sizeBytes`, `encrypted`
  (boolean, default false), `sha256Hex` (varchar 64),
  `createdAt`. Index on `(workspaceId, sha256Hex)`.
- **`entities` table**: nanoid PK, `workspaceId` (FK →
  workspaces, cascade), `currentVersionId` (FK → entityVersions,
  restrict), `createdAt`.
- **`entityVersions` table**: nanoid PK, `entityId` (FK →
  entities, cascade), `createdAt`.
- **`fields` table**: nanoid PK, `propertyId` (FK → properties,
  cascade), `entityVersionId` (FK → entityVersions, cascade),
  `fileId` (FK → files, restrict, nullable), `content` (JSONB).
  Unique index on `(propertyId, entityVersionId)`.
  Check constraint: `fields_file_id_v1_check` enforces that
  `content.type === "file"` ↔ `fileId IS NOT NULL` for version 1.
- **`justifications` table**: `fieldId` (FK → fields, cascade),
  `fileId` (FK → files, restrict). Justifications are pinned to
  the specific physical file.
- Drizzle relations defined for entity → versions → fields →
  files chain.

### 2. S3 Key Derivation

`apps/api/src/handlers/files/utils.ts`:

- `createFileKey` derives from org ID, workspace ID, file nanoid,
  and MIME type: `{organizationId}/{workspaceId}/{fileId}.{ext}`.

### 3. Backend Handlers

**Upload handler** (`apps/api/src/handlers/entities/upload.ts`):

- `POST /entities/:workspaceId/upload`
  - Accept multipart form via `t.File`: file blob + `name` +
    `propertyId`
  - Enforce 50MB size limit
  - Compute SHA-256 of the uploaded file server-side
  - Check for duplicate hash within the same workspace; reject
    or warn if duplicate found
  - Accept any file type (no MIME type restriction)
  - If PDF: check encryption via `isEncryptedPdf()`
    (`@libpdf/core`)
  - Generate file nanoid, upload to S3
  - In a single transaction: insert `files` row, insert
    `entities` row, insert `entityVersions` row, update
    `entities.currentVersionId`, insert `fields` row with
    `fileId` and `content: { version: 1, type: "file" }`
  - Return entity ID + file ID + file metadata

**Read handler** (`apps/api/src/handlers/files/read-by-id.ts`):

- `GET /files/:workspaceId/url/:id`
  - Fetch file metadata from DB (verify org/workspace access)
  - Generate presigned S3 URL (15 min expiry)
  - Return `{ mimeType, fileName, encrypted, presignedUrl }`

**Remove old handlers:**

- `apps/api/src/handlers/files/presign.ts` — delete (if exists)
- `apps/api/src/handlers/files/create.ts` — delete (if exists)
- `apps/api/src/handlers/files/schemas.ts` — delete (if exists)

### 4. Encrypted PDF Detection

`apps/api/src/handlers/files/pdf-utils.ts`:

- `isEncryptedPdf()`: use `@libpdf/core` (`PDF.load`) with error
  handling. If `PDF.load` throws on an encrypted file, return
  `true`. Non-PDF files return `false`.

### 5. S3 Cleanup on Delete

- **Entity delete** (`apps/api/src/handlers/entities/delete.ts`):
  before deleting entities, resolve their associated files via
  `entityVersions → fields → files`, delete S3 objects, then
  delete DB records (entities cascade to versions and fields;
  files deleted explicitly after FK constraints are removed).
- **Workspace delete**: ensure cascade deletes propagate through
  entities → versions → fields, and add a pre-delete step to
  clean up S3 objects for all files in the workspace.

### 6. Frontend Changes

`apps/web/src/routes/_protected.workspaces/$workspaceId/`:

- **Replace `useUploadToS3` and `useCreateFiles`** (if they
  still exist) with the direct upload to the backend proxy.
  The upload hook posts the file to
  `POST /entities/:workspaceId/upload` via `FormData`, which
  handles file + entity + version + field creation in one
  request.
- **`use-create-file-entities.ts`**: batch upload flow:
  1. Fetch properties, find the file property
  2. Upload files in parallel batches
     (`MAX_PARALLEL_FILE_UPLOADS`)
  3. Each upload creates the entity + file in one request
  4. Report renamed files, success/error summary via toast
- **Remove SHA-256 hashing on the client**: deduplication is
  handled server-side.
- **File queries**: use `GET /files/:workspaceId/url/:id` to
  get presigned download URLs.

### 7. AI Workflow Update

`apps/api/src/handlers/registry/actors/workflow/generate-batch.ts`:

- Define an `AI_SUPPORTED_MIME_TYPES` array (initially
  `["application/pdf"]`). When creating a field for an uploaded
  file, set the field content status to `unsupported` if:
  - the file's MIME type is not in `AI_SUPPORTED_MIME_TYPES`, or
  - the file's `encrypted` flag is `true`
- Resolve files through the entity chain: entity →
  `currentVersion` → fields (file-type) → `fileId` → file
  metadata + S3 key.
- The S3 key derivation uses org/workspace/fileId-based keys.
- Bates numbering, AI call, and justification parsing are
  unchanged. Justifications reference `fileId` directly (pinned
  to the physical file analyzed).

### 8. Entity Integration

- **`fields.fileId`** (FK → files, restrict): file-type fields
  carry the physical file reference. The check constraint ensures
  `content.type === "file"` ↔ `fileId IS NOT NULL`.
- **`justifications.fileId`** (FK → files, restrict):
  justifications are pinned to the exact physical file version
  analyzed by AI. Bounding boxes and Bates numbers are specific
  to a file's page layout.
- Entity creation via `POST /entities/:workspaceId/upload`:
  creates the entity, version, field (with fileId), and file
  record in one transaction.
- Empty entity creation via `PUT /entities/:workspaceId`:
  creates an entity with a version but no file-type field.
- Field upsert via `POST /fields/:workspaceId`: updates
  text/select fields on the current entity version.

## Test Cases

- Upload a PDF: file appears in S3, entity + entityVersion +
  field + file records created, `currentVersionId` points to the
  new version
- Upload an encrypted PDF: `encrypted` flag is `true`, field
  content status set to `unsupported` in AI workflow
- Upload a non-PDF: `encrypted` is `false`, field content status
  set to `unsupported` for AI workflows
- Upload duplicate file in same workspace: rejected with
  appropriate error
- Upload same file in different workspace: succeeds
- Delete entity: associated S3 objects and DB records cleaned up
  (S3 deleted before DB)
- Delete workspace: all files and S3 objects cleaned up
- Reject files exceeding 50MB
- Workspace isolation: cannot access files from another
  workspace/organization
- AI workflow correctly resolves files through entity → version →
  field → file chain
- `fields_file_id_v1_check` constraint enforced: file-type fields
  require `fileId`, non-file fields require `fileId IS NULL`
