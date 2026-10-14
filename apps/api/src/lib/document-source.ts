/**
 * Provenance of a stored document version: where its bytes came from.
 *
 * A discriminated union (not a boolean flag) keyed on `kind` so a later
 * import slice can add the `sharepoint` branch without migrating a
 * yes/no column, and so callers must switch exhaustively:
 *   - "upload": the user uploaded the file directly (presigned PUT).
 *   - "desktop-edit": the bytes came back from a desktop Word edit round-trip.
 *   - "collaboration": the version was published from a browser collaboration room.
 *   - "comparison": the version is a tracked-changes redline generated from
 *     two stored versions of the same document.
 *   - "signature": the version is the base version's PDF with a PAdES
 *     signature appended. The payload pins what was signed and with which
 *     certificate, so provenance survives without re-parsing the bytes.
 *   - "sharepoint": the version was copied (one-way, read-only) from a
 *     Microsoft Graph drive item the user had permission to read. The
 *     payload pins the exact item and its ETag at copy time so a later
 *     re-import can detect drift without a sync loop.
 *   - "import": the file was brought in from another system. The payload
 *     keeps what that system recorded and stella cannot recreate: its id
 *     for the file, the original creation and modification times, and the
 *     author's name when the author is not a stella user. The version's own
 *     `createdAt`/`createdBy` stay the import's, so queues, retention and
 *     audit keep reading when the bytes entered stella.
 *
 * `sharepoint` is reserved for the future SharePoint/OneDrive import pipeline.
 */

import * as v from "valibot";

import {
  EXTERNAL_ID_MAX_LENGTH,
  EXTERNAL_SOURCE_MAX_LENGTH,
  EXTERNAL_SOURCE_PATTERN,
} from "@/api/lib/imports/external-ref-limits";

export const ORIGINAL_AUTHOR_NAME_MAX_LENGTH = 256;

export const documentSourceSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("upload") }),
  v.strictObject({ kind: v.literal("desktop-edit") }),
  v.strictObject({ kind: v.literal("collaboration") }),
  v.strictObject({
    kind: v.literal("comparison"),
    baseVersionId: v.pipe(v.string(), v.uuid()),
    targetVersionId: v.pipe(v.string(), v.uuid()),
    mode: v.picklist(["strict", "best-effort"]),
    granularity: v.picklist(["word", "character"]),
    baseTrackedChanges: v.picklist(["keep", "accept", "reject"]),
    targetTrackedChanges: v.picklist(["keep", "accept", "reject"]),
  }),
  v.strictObject({
    kind: v.literal("signature"),
    baseVersionId: v.pipe(v.string(), v.uuid()),
    certificateSha256Hex: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
    signingTime: v.pipe(v.string(), v.isoTimestamp()),
    level: v.picklist(["B-B", "B-T", "B-LT"]),
    /** The authority whose trusted time the signature carries. */
    timestampAuthorityUrl: v.nullable(v.pipe(v.string(), v.url())),
    /** Why `level` is what it is when it fell short of the configuration. */
    warnings: v.pipe(
      v.array(
        v.strictObject({
          code: v.pipe(v.string(), v.maxLength(64)),
          message: v.pipe(v.string(), v.maxLength(500)),
        }),
      ),
      v.maxLength(20),
    ),
  }),
  v.strictObject({
    kind: v.literal("sharepoint"),
    driveId: v.pipe(v.string(), v.minLength(1)),
    itemId: v.pipe(v.string(), v.minLength(1)),
    eTag: v.string(),
    webUrl: v.pipe(v.string(), v.url()),
  }),
  v.strictObject({
    kind: v.literal("import"),
    externalSource: v.pipe(
      v.string(),
      v.maxLength(EXTERNAL_SOURCE_MAX_LENGTH),
      v.regex(EXTERNAL_SOURCE_PATTERN),
    ),
    externalId: v.nullable(
      v.pipe(v.string(), v.minLength(1), v.maxLength(EXTERNAL_ID_MAX_LENGTH)),
    ),
    originalCreatedAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
    originalModifiedAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
    originalAuthorName: v.nullable(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(ORIGINAL_AUTHOR_NAME_MAX_LENGTH),
      ),
    ),
  }),
]);

export type DocumentSource = v.InferOutput<typeof documentSourceSchema>;

export type ImportDocumentSource = Extract<DocumentSource, { kind: "import" }>;

/** Constant provenance of a direct upload. */
export const UPLOAD_DOCUMENT_SOURCE: DocumentSource = { kind: "upload" };

/** Constant desktop-edit provenance — produced by edit round-trip paths. */
export const DESKTOP_EDIT_DOCUMENT_SOURCE: DocumentSource = {
  kind: "desktop-edit",
};

/** Constant browser-collaboration provenance, used by room publications. */
export const COLLABORATION_DOCUMENT_SOURCE: DocumentSource = {
  kind: "collaboration",
};
