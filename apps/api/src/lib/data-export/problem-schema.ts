import * as v from "valibot";

import {
  dataExportArchivePathSchema,
  dataExportIdSchema,
  dataExportSha256Schema,
} from "@/api/lib/data-export/manifest-values";

/** Why a stored file could not be put in the archive. */
const ABSENT_FILE_REASONS = ["missing", "fetch_failed"] as const;

/**
 * Something that needs attention. `missing` and `fetch_failed` files are
 * not in the archive. A `checksum_mismatch` file is in the archive as
 * stored; its file record carries the SHA-256 of those bytes, and
 * `recordedSha256` is the checksum recorded when it was uploaded. A
 * `matter_unavailable` matter was planned for this part but could no
 * longer be read (deleted, or no longer visible to the requester), so none
 * of it is in the archive. A `planned_item_unavailable` item was in the
 * stored plan but can no longer be read; it is never silently omitted.
 */
export const dataExportProblemSchema = v.variant("reason", [
  v.strictObject({
    reason: v.literal("planned_item_unavailable"),
    matterId: dataExportIdSchema,
    itemType: v.picklist(["document", "version", "folder"]),
    itemId: dataExportIdSchema,
  }),
  v.strictObject({
    reason: v.picklist(ABSENT_FILE_REASONS),
    path: dataExportArchivePathSchema,
    fileId: dataExportIdSchema,
  }),
  v.strictObject({
    reason: v.literal("checksum_mismatch"),
    path: dataExportArchivePathSchema,
    fileId: dataExportIdSchema,
    recordedSha256: dataExportSha256Schema,
  }),
  v.strictObject({
    reason: v.literal("matter_unavailable"),
    matterId: dataExportIdSchema,
  }),
]);

/** The same problem contract is stored in part checkpoints and published manifests. */
export type DataExportProblemRecord = v.InferOutput<
  typeof dataExportProblemSchema
>;
