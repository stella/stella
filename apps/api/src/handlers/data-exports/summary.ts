// What the API, MCP and CLI show about one export: lifecycle, progress and
// finished parts. Storage keys and the requester's internal state stay out.

import { organizationDataExports } from "@/api/db/schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { brandPersistedDataExportId } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

export const DATA_EXPORT_PAGE_SIZE_DEFAULT = 20;
export const DATA_EXPORT_PAGE_SIZE_MAX = 100;

export const dataExportCreatedAtCursor = createTimestampIdCursorCodec({
  column: organizationDataExports.createdAt,
  brandId: brandPersistedDataExportId,
});

/** What a list row shows: no parts, so a page stays small. */
export const dataExportListColumns = {
  id: organizationDataExports.id,
  status: organizationDataExports.status,
  versionScope: organizationDataExports.versionScope,
  requestedBy: organizationDataExports.requestedBy,
  mattersTotal: organizationDataExports.mattersTotal,
  mattersDone: organizationDataExports.mattersDone,
  bytesTotal: organizationDataExports.bytesTotal,
  bytesDone: organizationDataExports.bytesDone,
  partCount: organizationDataExports.partCount,
  problemCount: organizationDataExports.problemCount,
  error: organizationDataExports.error,
  createdAt: organizationDataExports.createdAt,
  startedAt: organizationDataExports.startedAt,
  completedAt: organizationDataExports.completedAt,
  expiresAt: organizationDataExports.expiresAt,
};

/** One export in full: the list row plus its finished parts. */
export const dataExportSummaryColumns = {
  ...dataExportListColumns,
  parts: organizationDataExports.parts,
};

type ListRow = {
  [
    K in keyof typeof dataExportListColumns
  ]: (typeof organizationDataExports.$inferSelect)[K];
};

type SummaryRow = {
  [
    K in keyof typeof dataExportSummaryColumns
  ]: (typeof organizationDataExports.$inferSelect)[K];
};

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

// Below this much packed data the rate is too noisy to show an estimate.
const ETA_MIN_BYTES_DONE = 50 * 1024 * 1024;

/**
 * Seconds left at the average rate so far, or null while there is too
 * little to go on. Cheap and rough on purpose: the run is paced, so the
 * rate already reflects how much room it is given.
 */
const estimateSecondsRemaining = (row: ListRow, now: Date): number | null => {
  if (
    row.status !== "running" ||
    row.startedAt === null ||
    row.bytesDone < ETA_MIN_BYTES_DONE ||
    row.bytesTotal <= row.bytesDone
  ) {
    return null;
  }
  const elapsedSeconds = (now.getTime() - row.startedAt.getTime()) / 1000;
  const bytesPerSecond = row.bytesDone / Math.max(elapsedSeconds, 1);
  return Math.ceil((row.bytesTotal - row.bytesDone) / bytesPerSecond);
};

/** A list row: lifecycle, progress and expiry, without parts. */
export const toDataExportListItem = (row: ListRow, now = new Date()) => ({
  id: row.id,
  status: row.status,
  scope: { versions: row.versionScope },
  requestedBy: row.requestedBy,
  progress: {
    mattersTotal: row.mattersTotal,
    mattersDone: row.mattersDone,
    bytesTotal: row.bytesTotal,
    bytesDone: row.bytesDone,
    estimatedSecondsRemaining: estimateSecondsRemaining(row, now),
  },
  partCount: row.partCount,
  problemCount: row.problemCount,
  error: row.error,
  createdAt: row.createdAt.toISOString(),
  startedAt: iso(row.startedAt),
  completedAt: iso(row.completedAt),
  expiresAt: iso(row.expiresAt),
});

/** One export in full: the list row plus its downloadable parts. */
export const toDataExportSummary = (row: SummaryRow, now = new Date()) => ({
  ...toDataExportListItem(row, now),
  // Parts are listed only once the export is ready; before that the count
  // is the plan, and after expiry the files are gone.
  parts:
    row.status === "ready"
      ? row.parts.map((part) => ({
          index: part.index,
          fileName: sanitizeFilename(part.fileName),
          sizeBytes: part.sizeBytes,
          sha256: part.sha256,
          matterCount: part.matterIds.length,
          fileCount: part.fileCount,
        }))
      : [],
});

type DataExportRow = typeof organizationDataExports.$inferSelect;

export const UNPROJECTED_DATA_EXPORT_COLUMNS = [
  // The authenticated organization scopes the query; it is not response data.
  "organizationId",
  // The worker's immutable split plan stays internal; clients receive progress.
  "plan",
  // Run fencing and retry bookkeeping are worker state.
  "attempt",
  "failures",
  // Heartbeats detect lost workers; clients receive lifecycle timestamps.
  "heartbeatAt",
] as const satisfies readonly (keyof DataExportRow)[];

type UnprojectedDataExportColumn =
  (typeof UNPROJECTED_DATA_EXPORT_COLUMNS)[number];

true satisfies UnprojectedColumns<
  DataExportRow,
  SummaryRow,
  UnprojectedDataExportColumn
> extends never
  ? true
  : never;
true satisfies UnbackedProjectionKeys<
  DataExportRow,
  SummaryRow,
  UnprojectedDataExportColumn
> extends never
  ? true
  : never;

// Reconcile nested response fields with their source columns. The ETA is
// computed from progress, while scope.versions renames versionScope.
type DataExportListItem = ReturnType<typeof toDataExportListItem>;
type FlatDataExportListItem = Omit<DataExportListItem, "scope" | "progress"> &
  Omit<DataExportListItem["progress"], "estimatedSecondsRemaining"> & {
    versionScope: DataExportListItem["scope"]["versions"];
  };

true satisfies UnprojectedColumns<ListRow, FlatDataExportListItem> extends never
  ? true
  : never;
true satisfies UnbackedProjectionKeys<
  ListRow,
  FlatDataExportListItem
> extends never
  ? true
  : never;
