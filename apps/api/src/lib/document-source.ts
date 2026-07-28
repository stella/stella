/**
 * Provenance of a stored document version: where its bytes came from.
 *
 * A discriminated union (not a boolean flag) keyed on `kind` so a later
 * import slice can add the `sharepoint` branch without migrating a
 * yes/no column, and so callers must switch exhaustively:
 *   - "upload": the user uploaded the file directly (presigned PUT).
 *   - "desktop-edit": the bytes came back from a desktop / collaborative
 *     Word edit round-trip.
 *   - "sharepoint": the version was copied (one-way, read-only) from a
 *     Microsoft Graph drive item the user had permission to read. The
 *     payload pins the exact item and its ETag at copy time so a later
 *     re-import can detect drift without a sync loop.
 *
 * Groundwork: only `upload` and `desktop-edit` are produced today. The
 * `sharepoint` branch is populated by the future SharePoint/OneDrive
 * import pipeline (deferred).
 */

import * as v from "valibot";

export const DOCUMENT_SOURCE_KINDS = [
  "upload",
  "desktop-edit",
  "sharepoint",
] as const;

export type DocumentSourceKind = (typeof DOCUMENT_SOURCE_KINDS)[number];

export const documentSourceSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("upload") }),
  v.strictObject({ kind: v.literal("desktop-edit") }),
  v.strictObject({
    kind: v.literal("sharepoint"),
    driveId: v.pipe(v.string(), v.minLength(1)),
    itemId: v.pipe(v.string(), v.minLength(1)),
    eTag: v.string(),
    webUrl: v.pipe(v.string(), v.url()),
  }),
]);

export type DocumentSource = v.InferOutput<typeof documentSourceSchema>;

/** Constant upload provenance — the only branch produced by upload paths. */
export const UPLOAD_DOCUMENT_SOURCE: DocumentSource = { kind: "upload" };

/** Constant desktop-edit provenance — produced by edit round-trip paths. */
export const DESKTOP_EDIT_DOCUMENT_SOURCE: DocumentSource = {
  kind: "desktop-edit",
};

/**
 * Stable machine label for the source kind. Read the union with a
 * `switch` plus a `never` exhaustiveness check so a newly added branch
 * fails to typecheck until it is handled here.
 */
export const documentSourceKind = (
  source: DocumentSource,
): DocumentSourceKind => {
  switch (source.kind) {
    case "upload":
      return "upload";
    case "desktop-edit":
      return "desktop-edit";
    case "sharepoint":
      return "sharepoint";
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
};

/**
 * Whether a version originated from an external import (vs. authored in
 * the workspace). Same exhaustive `switch`/`never` shape.
 */
export const isImportedDocumentSource = (source: DocumentSource): boolean => {
  switch (source.kind) {
    case "sharepoint":
      return true;
    case "upload":
    case "desktop-edit":
      return false;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
};
