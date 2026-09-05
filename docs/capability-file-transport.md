# Capability file transport (CLI + MCP)

Status: design. Companion to `docs/capability-coverage.md`.

## Problem

The generic capability transport (`invoke_capability`) carries JSON in and JSON
out. A capability whose input contains a `t.File()` field, or whose success value
is a web `Response`/raw bytes, cannot cross it.

What each such capability says about itself lives on its handler config as
`transport` (`apps/api/src/lib/capability-transport.ts`), a total discriminated
disposition:

```ts
type CapabilityTransport =
  | { type: "json" }
  | { type: "file-input"; input: CapabilityFileInput; alternative: … }
  | { type: "file-response"; response: CapabilityFileResponse; alternative: … }
  | { type: "file-both"; input: …; response: …; alternative: … };
```

It replaced two booleans (`requiresFileInput`, `returnsFileResponse`) that could
only say "file-shaped, therefore unreachable" — not which field carries the
bytes, not whether those bytes are optional, and not where the same work could be
done instead.

The disposition is projected onto every catalog entry (the field is total, so a
consumer never reads an absence as a decision) and drives three things:

- `insertCapabilities` in `packages/cli/src/generate-capability-tree.ts` drops a
  suppressed entry from the CLI tree;
- `invokeCapability` in `apps/api/src/mcp/capability-tools.ts` refuses one
  pre-execution, quoting its alternative;
- the generated coverage doc states, per row, why an entry is excluded and where
  to go instead.

**Suppressed** means a file response, or a REQUIRED file input. An OPTIONAL file
input is not suppressed: the capability's JSON modes still run, with the file
field withheld (see "Fileless mode").

Omitting `transport` declares `{ type: "json" }`. That default cannot silently
absorb a file capability: the exporter re-derives BOTH legs from the live schema
(`scanBinarySchemaFields`) and the handler source (`scanFileResponseReturns`) and
fails on any disagreement — a missing declaration, a field that is not binary, a
stale `required` after an optionality flip, or a response leg on a handler that
no longer returns bytes. The `require-file-transport-disposition` lint rule flags
the same omission at author time for the common case (schema and config in one
module).

On the catalog as of this writing: **20 of 313** entries are suppressed, and one
(`templates.prefill`) is exposed in fileless mode.

## Classified inventory

`IN` = file input, `OUT` = file response. "Alternative" is the entry's declared
alternative transport.

| Capability                     | IN         | OUT | Alternative                                                        |
| ------------------------------ | ---------- | --- | ------------------------------------------------------------------ |
| `entities.upload`              | x          |     | complete: `uploads.create` + `uploads.update` (`entity_create`)     |
| `entities.upload-version`      | x          |     | complete: `uploads.create` + `uploads.update` (`entity_version`)    |
| `skills.upload`                | x          |     | complete: `uploads.create` + `uploads.update` (`agent_skill`)       |
| `templates.fill-by-id`         |            | x   | complete: `templates.fill-to-matter`                             |
| `clauses.import`               | x          |     | partial: `clauses.create` (one clause per call, no CSV bulk)        |
| `clauses.export`               |            | x   | partial: `clauses.list` + `clauses.get` (no single export file)     |
| `skills.resources.upload`      | x          |     | partial: `skills.resources.create` (text only, no binary resource)  |
| `style-sets.create`            | x          |     | partial: `style-sets.create-from-editor` (settings, not a DOCX)     |
| `style-sets.replace`           | x          |     | partial: `style-sets.update-from-editor` (settings, not a DOCX)     |
| `templates.create-from-styles` | x          |     | partial: style set from editor, then `create-from-style-set`        |
| `templates.fill`               | x          | x   | partial: `templates.fill-to-matter` (stored template, to matter) |
| `time-entries.export-pdf`      |            | x   | partial: `export-csv` / `export-ledes` (no rendered PDF)            |
| `entities.check-stamp`         | x          |     | none                                                                |
| `entities.download-zip`        |            | x   | none                                                                |
| `templates.create`             | x          |     | none                                                                |
| `templates.discover`           | x          |     | none                                                                |
| `templates.manifest`           | x          | x   | none                                                                |
| `templates.prepare`            | x          |     | none                                                                |
| `templates.save-document`      | x          |     | none                                                                |
| `views.table-export`           |            | x   | none                                                                |
| `templates.prefill`            | x (opt.)   |     | none (exposed: fileless mode)                                       |

Four complete alternatives, eight partial alternatives, and nine entries with no
alternative.

## Fileless mode

`templates.prefill` takes its source material as an uploaded DOCX/PDF, pasted
`text`, or `entityIds` naming stored documents — any one of the three. Only the
first needs bytes, so the capability is invocable over JSON and both clients
generate it, with the `file` field withheld:

- the CLI emits no `--file` flag and strips the field from the `--input` wrapper
  schema, and `--help` says the command covers the JSON modes only;
- `invoke_capability` removes the field from the live TypeBox schema before
  validating (a `t.File()` carries `default: "File"`, which the Default step
  would otherwise inject into the absent optional field and then reject), and
  refuses a call that supplies the field rather than dropping it — a
  bytes-as-a-string value must never produce a success computed from the other
  sources.

`required: false` on the declaration is cross-checked against the schema's
`required` list, so flipping `t.Optional` fails the export until the transport is
re-reviewed. That flip is exactly the moment a capability enters or leaves the
agent surface.

## Where the work could go next (not built)

This document's earlier revisions proposed a staged-file transport. That work is
deferred; what follows is the shape it would take, unchanged.

### Class A — file-in, already served by the presigned slice

`apps/api/src/handlers/uploads/` is a complete presign -> PUT -> finalize
coordinator. Its `purpose` union covers exactly three cases, which map onto the
three complete-alternative capabilities:

| Capability                | Presign purpose  |
| ------------------------- | ---------------- |
| `entities.upload`         | `entity_create`  |
| `entities.upload-version` | `entity_version` |
| `skills.upload`           | `agent_skill`    |

The slice is exposed as `{ type: "capability" }` (`uploads.create` /
`uploads.update` / `uploads.delete`) and both clients drive it. The legacy
multipart endpoints beside it are **not** un-suppressed: they take
`multipart/form-data` with a real `File`, and a plain string would pass schema
validation and reach a handler that expects one. They stay suppressed
permanently and correctly.

### Class B — file-in with no presign purpose

The remaining file-in capabilities have no corresponding `purpose`. Two
sub-cases:

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

`views.table-export` also serves `xlsx`/`docx`, which are binary, so it is class
C only for its text formats and class D otherwise.

### Class D — file-out that is genuinely binary

`entities.download-zip` (streamed zip via `client-zip`), `templates.fill` /
`templates.fill-by-id` (DOCX/PDF `Uint8Array`), `templates.manifest` (a
rewritten DOCX), `time-entries.export-pdf` (`buildMinimalPdf`), and
`views.table-export` in `xlsx`/`docx`. None of these is a pre-existing S3 object,
so there is no URL to presign without first materializing the bytes.

These need a **materialize-then-presign** step: run the handler, write the bytes
to the same organization/workspace-scoped `tmp/` prefix the upload staging path
uses, and return a presigned GET URL with a short TTL. That reuses
`presignDownloadUrl` / `auditedPresignDownload` in
`apps/api/src/lib/s3-presign.ts` and the existing 24h `stella-upload-stage=tmp`
lifecycle rule, so no new retention surface is created.

## What each client would get

**MCP** gets presigned URLs, never bytes. An AI client should not carry a DOCX
through its context window, and base64 in a tool result is both lossy on token
budget and unusable downstream. So:

- upload: `uploads.create` returns `{ uploadId, url, expiresAt, headers }`; the
  client PUTs the bytes itself and calls `uploads.update`.
- download: the materialize step returns `{ url, expiresAt, filename, bytes }`.

**CLI** gets local paths, because a human or an agent shell has a filesystem:

- `--file <path>` on upload leaves: hash -> presign -> PUT -> finalize, with
  best-effort `uploads.delete` on any failure after presign, mirroring
  `apps/web/src/lib/workspaces/mutations/use-create-file-entities.ts`.
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
- Exposing a capability in fileless mode changes only which JSON modes are
  reachable. Scope, permissions, rate limit, and RLS are untouched, and the
  generic invoke path applies its own scope and destructive-confirm gates on top.
- Download URLs are minted per request with a short TTL and audited through
  `auditedPresignDownload`; the materialized object inherits the existing tmp
  lifecycle expiry.

## Implementation notes

**Naming.** The three upload endpoints are `uploads.create` / `uploads.update` /
`uploads.delete`, not `presign` / `finalize` / `abort`. The exporter enforces
canonical action verbs, and its `DOMAIN_ACTION_VERBS` escape hatch is ratcheted
downward (`capability-domain-action-verbs`), so adding three verbs there would
have regressed a guard to buy nicer names. The handler files were renamed
instead; the REST paths (`/presign`, `/:uploadId/finalize`, `/:uploadId/abort`)
are unchanged, so no HTTP client is affected. Each capability carries a
description that states its step number and names the next call, which is what an
agent reads.

**Rate limiting.** `invoke_capability` bypasses the Elysia route middleware, so
the `upload-presigned` limiter (500/min, `API_RATE_LIMITS.upload`) does not
apply on the generic path. These capabilities inherit
`DEFAULT_INVOKE_RATE_LIMIT` (60/min per organization per capability), which is
**stricter** than the route, so the invariant in `capability-rate-limit.ts`
("never looser than the route it stands in for") holds without an override
entry. At two invokes per file that caps generic-path bulk upload at ~30
files/min; if that proves too tight, the fix is an explicit capability
rate-limit policy entry, not removing the default.

## Suppression accounting

`suppressed` must mean "cannot work over a file transport", not "nobody has done
the work yet". A ratchet metric (`capability-file-transport-suppressed`) freezes
the count so a newly suppressed capability cannot appear without a reviewed
baseline bump. The metric counts a capability, not a flag, and excludes an
optional file input — so exposing a fileless mode is a real burn-down, and
re-suppressing one shows up as a regression.
