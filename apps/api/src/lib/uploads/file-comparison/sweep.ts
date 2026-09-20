import { Result } from "better-result";
import { and, asc, inArray, lte } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { fileComparisonUploads } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { deleteS3ObjectWithSignal } from "@/api/lib/s3";
import { fileComparisonObjectKey } from "@/api/lib/uploads/file-comparison/uploads";
import { withTimeout } from "@/api/lib/with-timeout";

/** One sweep tick clears at most this many rows, across every organization. */
export const FILE_COMPARISON_SWEEP_LIMIT = 50;

const FILE_COMPARISON_DELETE_TIMEOUT_MS = 30 * 1000;

type SweepOptions = {
  deleteObject?: typeof deleteS3ObjectWithSignal;
  limit?: number;
  safeDb: SafeDb;
  signal?: AbortSignal | undefined;
};

type ExpiredRow = {
  id: SafeId<"fileComparisonUpload">;
  organizationId: SafeId<"organization">;
};

/**
 * Delete what expired: the object first, then the row that names it. The order
 * is the whole design — a row removed before its object leaves bytes nothing
 * can name, while an object removed before its row leaves a row the next tick
 * retries harmlessly, because deleting an absent key succeeds.
 *
 * Rows are read outside the delete so the object-store calls do not run inside
 * a transaction, and both statements are bounded, so a backlog drains over
 * several ticks rather than in one long sweep.
 */
export const sweepExpiredFileComparisonUploads = async ({
  deleteObject = deleteS3ObjectWithSignal,
  limit = FILE_COMPARISON_SWEEP_LIMIT,
  safeDb,
  signal,
}: SweepOptions): Promise<number> => {
  const expired = await safeDb(
    async (tx) =>
      await tx
        .select({
          id: fileComparisonUploads.id,
          organizationId: fileComparisonUploads.organizationId,
        })
        .from(fileComparisonUploads)
        .where(lte(fileComparisonUploads.expiresAt, new Date()))
        .orderBy(
          asc(fileComparisonUploads.expiresAt),
          asc(fileComparisonUploads.id),
        )
        .limit(limit),
  );
  if (Result.isError(expired) || expired.value.length === 0) {
    return 0;
  }

  const cleared = await Promise.all(
    expired.value.map(async (row: ExpiredRow) => {
      const key = fileComparisonObjectKey({
        organizationId: row.organizationId,
        uploadId: row.id,
      });
      const deleted = await Result.tryPromise({
        try: async () =>
          await withTimeout(
            async (operationSignal) => await deleteObject(key, operationSignal),
            {
              label: "file-comparison.sweep.delete",
              signal,
              timeoutMs: FILE_COMPARISON_DELETE_TIMEOUT_MS,
            },
          ),
        catch: (cause) => cause,
      });
      if (Result.isError(deleted)) {
        // The row stays, so the next tick retries this key.
        captureError(deleted.error, {
          fileComparisonUploadId: row.id,
          objectKey: key,
          stage: "file-comparison-sweep",
        });
        return null;
      }
      return row.id;
    }),
  );

  const clearedIds = cleared.filter(
    (id): id is SafeId<"fileComparisonUpload"> => id !== null,
  );
  if (clearedIds.length === 0) {
    return 0;
  }

  // audit: skip — expiry of the caller's own short-lived staging objects, whose
  // reservation and consumption are the audited events.
  const removed = await safeDb(
    async (tx) =>
      await tx
        .delete(fileComparisonUploads)
        .where(
          and(
            inArray(fileComparisonUploads.id, clearedIds),
            lte(fileComparisonUploads.expiresAt, new Date()),
          ),
        ),
  );
  return Result.isError(removed) ? 0 : clearedIds.length;
};
