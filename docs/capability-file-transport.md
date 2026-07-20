# Capability file transport (CLI + MCP)

Status: design. Companion to `docs/capability-coverage.md`.

## Problem

The generic capability transport (`invoke_capability`) carries JSON in and JSON
out. Capabilities whose input contains a `t.File()` field (`requiresFileInput`,
derived mechanically from `format: "binary"` in the live config schema) or whose
success value is a web `Response`/raw bytes (`returnsFileResponse`, a reviewed
seed list in `apps/api/scripts/export-capability-catalog.ts`) can never succeed
through it. `insertCapabilities` in `packages/cli/src/generate-capability-tree.ts`
therefore drops them from the CLI tree, and `invokeCapability` in
`apps/api/src/mcp/capability-tools.ts` refuses them pre-execution.

On the catalog as of `1dd0cc532d` that is **21 of 280** entries.

## Classified inventory

`IN` = `requiresFileInput`, `OUT` = `returnsFileResponse`.

| Capability | IN | OUT | Class |
| --- | --- | --- | --- |
| `entities.upload` | x | | A |
| `entities.upload-version` | x | | A |
| `skills.upload` | x | | A |
| `skills.resources.upload` | x | | B |
| `entities.check-stamp` | x | | B |
| `clauses.import` | x | | B |
| `style-sets.create` | x | | B |
| `style-sets.replace` | x | | B |
| `templates.create` | x | | B |
| `templates.create-from-styles` | x | | B |
| `templates.discover` | x | | B |
| `templates.manifest` | x | | B |
| `templates.prefill` | x | | B |
| `templates.prepare` | x | | B |
| `templates.save-document` | x | | B |
| `templates.fill` | x | x | B + D |
| `clauses.export` | | x | C |
| `views.table-export` | | x | C |
| `entities.download-zip` | | x | D |
| `templates.fill-by-id` | | x | D |
| `time-entries.export-pdf` | | x | D |

### Class A — file-in, already served by the presigned slice

`apps/api/src/handlers/uploads/` is a complete presign -> PUT -> finalize
coordinator (`routes.ts`, `presign.ts`, `finalize.ts`, `abort.ts`,
`entity-create-tree.ts`, `preflight-entity-create.ts`). Its `purpose` union
covers exactly three cases, which map onto the three class-A capabilities:

| Capability | Presign purpose |
| --- | --- |
| `entities.upload` | `entity_create` |
| `entities.upload-version` | `entity_version` |
| `skills.upload` | `agent_skill` |

Every one of those five upload endpoints is annotated
`mcp: { type: "internal", reason: "upload_mechanics" }`, so the whole slice is
waived out of the catalog and is invisible to both CLI and MCP. That waiver, not
the absence of a transport, is what makes the upload workflow unreachable.

**Decision: this is the one upload path.** No second upload mechanism is
introduced. The slice is re-exposed as `{ type: "capability" }` and both clients
drive it.

The legacy multipart endpoints (`POST /entities/:workspaceId/upload` and
friends) are **not** un-suppressed. They take `multipart/form-data` with a real
`File`; JSON input cannot carry one, and a plain string would pass schema
validation and reach a handler that expects a `File`. They stay suppressed
permanently and correctly. The workflow becomes reachable via the presigned
capabilities beside them, not by making the multipart route JSON-shaped.

### Class B — file-in with no presign purpose

Twelve capabilities take a `t.File()` body with no corresponding `purpose` in
the presign union. Two sub-cases:

- **Durable** (`skills.resources.upload`, `style-sets.create`,
  `style-sets.replace`, `clauses.import`, `templates.create`,
  `templates.create-from-styles`, `templates.save-document`): the bytes are
  persisted, so they want a real purpose variant (validation callback + finalize
  result) added to the presign union, exactly like `agent_skill`.
- **Transient** (`entities.check-stamp`, `templates.discover`,
  `templates.manifest`, `templates.prefill`, `templates.prepare`,
  `templates.fill`): the bytes are consumed to compute an answer and never
  stored. These want a `scratch` purpose whose finalize hands the handler a
  staged object key rather than committing anything, plus a handler-side switch
  from `file: t.File()` to `uploadId: SafeId`.

Both sub-cases are additive server work on the existing slice. Neither needs a
new transport.

### Class C — file-out that is already text

`clauses.export` returns `new Response(JSON.stringify(payload, null, 2))` and
`views.table-export` returns a `Response` whose body is a CSV string for
`format: "csv"`. The `Response` wrapper exists only to carry a
`Content-Disposition` filename; the payload is serializable. These do not need a
byte transport at all — the handlers can return the value and let the client
decide where to write it.

`views.table-export` also serves `xlsx`/`docx`, which are binary, so it is
class C only for its text formats and class D otherwise.

### Class D — file-out that is genuinely binary

`entities.download-zip` (streamed zip via `client-zip`), `templates.fill` /
`templates.fill-by-id` (DOCX/PDF `Uint8Array`), `time-entries.export-pdf`
(`buildMinimalPdf`), and `views.table-export` in `xlsx`/`docx`. None of these is
a pre-existing S3 object, so there is no URL to presign without first
materializing the bytes.

These need a **materialize-then-presign** step: run the handler, write the bytes
to the same organization/workspace-scoped `tmp/` prefix the upload staging path
uses, and return a presigned GET URL with a short TTL. That reuses
`presignDownloadUrl` / `auditedPresignDownload` in
`apps/api/src/lib/s3-presign.ts` and the existing 24h `stella-upload-stage=tmp`
lifecycle rule, so no new retention surface is created.

## What each client gets

**MCP** gets presigned URLs, never bytes. An AI client should not carry a DOCX
through its context window, and base64 in a tool result is both lossy on token
budget and unusable downstream. So:

- upload: `uploads.presign` returns `{ uploadId, url, expiresAt, headers }`; the
  client PUTs the bytes itself and calls `uploads.finalize`.
- download: the materialize step returns `{ url, expiresAt, filename, bytes }`.

**CLI** gets local paths, because a human or an agent shell has a filesystem:

- `--file <path>` on upload leaves: hash -> presign -> PUT -> finalize, with
  best-effort `uploads.abort` on any failure after presign, mirroring
  `apps/web/src/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities.ts`.
- `--output <path|->` on download leaves: fetch the presigned URL and stream to
  the path, or to stdout for `-`.

The CLI's orchestration is a thin client over the same capabilities MCP sees.
There is no CLI-only server endpoint.

## Security invariants (unchanged)

- Upload URLs stay at `PRESIGN_URL_EXPIRY_SECONDS` (5 min) and remain bound to
  an exact `content-length` and `x-amz-checksum-sha256`, so a leaked URL inside
  the window cannot be reused for different bytes.
- Staging keys stay `${organizationId}/${workspaceId}/tmp/${uploadId}`, inside
  the STS session policy prefix enforced by `isS3KeyInSigningScope`.
- `authorizeUploadPurpose` continues to re-check the per-purpose permission
  (`entity:create`, `entity:update`, `agentSkill:create`) after the route-level
  workspace gate.
- Re-exposing the slice as `capability` changes only its catalog disposition.
  Scope, permissions, rate limit (`upload-presigned`), and RLS are untouched, and
  the generic invoke path applies its own scope and destructive-confirm gates on
  top.
- Download URLs are minted per request with a short TTL and audited through
  `auditedPresignDownload`; the materialized object inherits the existing tmp
  lifecycle expiry.

## Suppression accounting

`suppressed` must mean "cannot work over a file transport", not "nobody has done
the work yet". After the class-A/C work the residual set is the multipart
endpoints, which are permanently unreachable through JSON invoke. A ratchet
metric (`capability-file-transport-suppressed`) freezes the count so a newly
suppressed capability cannot appear without a reviewed baseline bump.
