import { panic, Result, TaggedError } from "better-result";
import { and, asc, inArray, lte } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { fileComparisonUploads } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/error-tag";
import { deleteOrganizationFileWithSignal } from "@/api/lib/files/delete-organization-file";
import { logger } from "@/api/lib/observability/logger";
import type { LoggerAttributes } from "@/api/lib/observability/logger";
import { fileComparisonObjectKey } from "@/api/lib/uploads/file-comparison/uploads";
import { withTimeout } from "@/api/lib/with-timeout";

/** One sweep tick clears at most this many rows, across every organization. */
export const FILE_COMPARISON_SWEEP_LIMIT = 50;

const FILE_COMPARISON_DELETE_TIMEOUT_MS = 30 * 1000;

type DeleteObject = (
  key: string,
  signal: AbortSignal,
) => Promise<
  Awaited<ReturnType<typeof deleteOrganizationFileWithSignal>> | undefined
>;

type SweepOptions = {
  deleteObject?: DeleteObject;
  limit?: number;
  safeDb: SafeDb;
  signal?: AbortSignal | undefined;
};

type SweepSummary = {
  scanned: number;
  sweptUploads: number;
  failed: number;
};

export class FileComparisonSweepError extends TaggedError(
  "FileComparisonSweepError",
)<{
  message: string;
  cause: unknown;
  summary: SweepSummary;
}> {}

type SweepFailureDiagnostic =
  | {
      stage: "object";
      cause: unknown;
      uploadId: SafeId<"fileComparisonUpload">;
    }
  | { stage: "rows"; cause: unknown; failed: number };

const reportSweepFailure = (diagnostic: SweepFailureDiagnostic) => {
  const attributes: LoggerAttributes = {
    "sweep.stage": diagnostic.stage,
    "error.type": errorTag(diagnostic.cause),
  };
  switch (diagnostic.stage) {
    case "object":
      attributes["fileComparisonUpload.id"] = diagnostic.uploadId;
      break;
    case "rows":
      attributes["fileComparisonUploads.failed"] = diagnostic.failed;
      break;
    default:
      diagnostic satisfies never;
      panic("Unhandled comparison sweep failure stage");
  }
  logger.warn("file_comparison.sweep_delete_failed", attributes);
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
  deleteObject = deleteOrganizationFileWithSignal,
  limit = FILE_COMPARISON_SWEEP_LIMIT,
  safeDb,
  signal,
}: SweepOptions): Promise<Result<SweepSummary, FileComparisonSweepError>> => {
  const summary = { scanned: 0, sweptUploads: 0, failed: 0 };
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
  if (Result.isError(expired)) {
    return Result.err(
      new FileComparisonSweepError({
        message: "Comparison expiry scan failed",
        cause: expired.error,
        summary,
      }),
    );
  }
  summary.scanned = expired.value.length;

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
      const deletion = Result.flatten(
        deleted.map((value) => value ?? Result.ok(undefined)),
      );
      if (Result.isError(deletion)) {
        // The row stays, so the next tick retries this key.
        reportSweepFailure({
          stage: "object",
          uploadId: row.id,
          cause: deletion.error,
        });
        return Result.err(deletion.error);
      }
      return Result.ok(row.id);
    }),
  );

  const clearedIds: SafeId<"fileComparisonUpload">[] = [];
  let failure: FileComparisonSweepError | undefined;
  // Promise.all preserves scan order, so the first cause is deterministic.
  for (const deletion of cleared) {
    if (Result.isError(deletion)) {
      summary.failed += 1;
      failure ??= new FileComparisonSweepError({
        message: "Comparison expiry deletion failed",
        cause: deletion.error,
        summary,
      });
      continue;
    }
    clearedIds.push(deletion.value);
  }
  if (clearedIds.length === 0) {
    return failure ? Result.err(failure) : Result.ok(summary);
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
        )
        .returning({ id: fileComparisonUploads.id }),
  );
  if (Result.isError(removed)) {
    summary.failed += clearedIds.length;
    reportSweepFailure({
      stage: "rows",
      failed: clearedIds.length,
      cause: removed.error,
    });
    failure ??= new FileComparisonSweepError({
      message: "Comparison expiry row removal failed",
      cause: removed.error,
      summary,
    });
  } else {
    summary.sweptUploads = removed.value.length;
  }
  return failure ? Result.err(failure) : Result.ok(summary);
};
