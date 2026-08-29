/**
 * Provenance of a stored document version: where its bytes came from.
 *
 * A discriminated union (not a boolean flag) keyed on `kind` so a later
 * import slice can add the `sharepoint` branch without migrating a
 * yes/no column, and so callers must switch exhaustively:
 *   - "upload": the user uploaded the file directly (presigned PUT).
 *   - "desktop-edit": the bytes came back from a desktop Word edit round-trip.
 *   - "collaboration": the version was published from a browser collaboration room.
 *   - "sharepoint": the version was copied (one-way, read-only) from a
 *     Microsoft Graph drive item the user had permission to read. The
 *     payload pins the exact item and its ETag at copy time so a later
 *     re-import can detect drift without a sync loop.
 *
 * Groundwork: `upload` and `desktop-edit` are produced today. `collaboration`
 * is reserved for room publication, and `sharepoint` for the future
 * SharePoint/OneDrive import pipeline.
 */

import * as v from "valibot";

export const documentSourceSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("upload") }),
  v.strictObject({ kind: v.literal("desktop-edit") }),
  v.strictObject({ kind: v.literal("collaboration") }),
  v.strictObject({
    kind: v.literal("sharepoint"),
    driveId: v.pipe(v.string(), v.minLength(1)),
    itemId: v.pipe(v.string(), v.minLength(1)),
    eTag: v.string(),
    webUrl: v.pipe(v.string(), v.url()),
  }),
]);

export type DocumentSource = v.InferOutput<typeof documentSourceSchema>;
export type DocumentSourceKind = DocumentSource["kind"];

/** Constant upload provenance — the only branch produced by upload paths. */
export const UPLOAD_DOCUMENT_SOURCE: DocumentSource = { kind: "upload" };

/** Constant desktop-edit provenance — produced by edit round-trip paths. */
export const DESKTOP_EDIT_DOCUMENT_SOURCE: DocumentSource = {
  kind: "desktop-edit",
};

/** Constant browser-collaboration provenance, used by room publications. */
export const COLLABORATION_DOCUMENT_SOURCE: DocumentSource = {
  kind: "collaboration",
};
