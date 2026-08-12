import { Result, UnhandledException } from "better-result";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { templateDeletionCleanupRequests } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { deleteS3Keys } from "@/api/lib/files/utils";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const CLEAN_TEMPLATE_DELETION_OBJECTS_TASK =
  "templates.cleanDeletionObjects" as const;

const CLEANUP_BATCH_SIZE = 32;
const CLEANUP_CONCURRENCY = 4;
const STALE_PROCESSING_MS = 15 * 60_000;
const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 24 * 60 * 60;

type ClaimedCleanup = {
  attemptCount: number;
  id: (typeof templateDeletionCleanupRequests.$inferSelect)["id"];
  s3Keys: string[];
};

export const getTemplateDeletionCleanupRetryAt = ({
  attemptCount,
  now,
}: {
  attemptCount: number;
  now: Date;
}): Date => {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
  const delaySeconds = Math.min(
    RETRY_BASE_SECONDS * 2 ** exponent,
    RETRY_MAX_SECONDS,
  );
  return new Date(now.getTime() + delaySeconds * 1000);
};

const claimCleanupBatch = async (): Promise<ClaimedCleanup[]> => {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  return await rootDb.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: templateDeletionCleanupRequests.id })
      .from(templateDeletionCleanupRequests)
      .where(
        or(
          eq(templateDeletionCleanupRequests.status, "pending"),
          and(
            eq(templateDeletionCleanupRequests.status, "failed"),
            lte(templateDeletionCleanupRequests.nextAttemptAt, now),
          ),
          and(
            eq(templateDeletionCleanupRequests.status, "processing"),
            sql`${templateDeletionCleanupRequests.updatedAt} < ${staleBefore}::timestamptz`,
          ),
        ),
      )
      .orderBy(
        asc(templateDeletionCleanupRequests.createdAt),
        asc(templateDeletionCleanupRequests.id),
      )
      .limit(CLEANUP_BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) {
      return [];
    }
    return await tx
      .update(templateDeletionCleanupRequests)
      .set({
        attemptCount: sql`${templateDeletionCleanupRequests.attemptCount} + 1`,
        errorMessage: null,
        nextAttemptAt: null,
        status: "processing",
        updatedAt: now,
      })
      .where(
        inArray(
          templateDeletionCleanupRequests.id,
          candidates.map(({ id }) => id),
        ),
      )
      .returning({
        attemptCount: templateDeletionCleanupRequests.attemptCount,
        id: templateDeletionCleanupRequests.id,
        s3Keys: templateDeletionCleanupRequests.s3Keys,
      });
  });
};

const processCleanup = async (claim: ClaimedCleanup): Promise<boolean> => {
  const deletion = await Result.tryPromise({
    try: async () => await deleteS3Keys(claim.s3Keys),
    catch: (cause) =>
      cause instanceof Error ? cause : new UnhandledException({ cause }),
  });
  let error: Error | null = null;
  if (Result.isError(deletion)) {
    error = deletion.error;
  } else if (Result.isError(deletion.value)) {
    error = deletion.value.error;
  }
  if (error !== null) {
    captureError(error, { cleanupRequestId: claim.id });
    const failedAt = new Date();
    await rootDb
      .update(templateDeletionCleanupRequests)
      .set({
        errorMessage: error.message,
        nextAttemptAt: getTemplateDeletionCleanupRetryAt({
          attemptCount: claim.attemptCount,
          now: failedAt,
        }),
        status: "failed",
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(templateDeletionCleanupRequests.id, claim.id),
          eq(templateDeletionCleanupRequests.status, "processing"),
          eq(templateDeletionCleanupRequests.attemptCount, claim.attemptCount),
        ),
      );
    return false;
  }
  await rootDb
    .update(templateDeletionCleanupRequests)
    .set({
      completedAt: new Date(),
      errorMessage: null,
      s3Keys: [],
      status: "completed",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(templateDeletionCleanupRequests.id, claim.id),
        eq(templateDeletionCleanupRequests.status, "processing"),
        eq(templateDeletionCleanupRequests.attemptCount, claim.attemptCount),
      ),
    );
  return true;
};

export const cleanTemplateDeletionObjects: SchedulerTask = async ({
  logger,
  signal,
}) => {
  if (signal.aborted) {
    return;
  }
  const claims = await claimCleanupBatch();
  let next = 0;
  let cleaned = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    const claim = claims.at(next);
    next += 1;
    if (!claim || signal.aborted) {
      return;
    }
    if (await processCleanup(claim)) {
      cleaned += 1;
    } else {
      failed += 1;
    }
    await worker();
  };
  await Promise.all(
    Array.from(
      { length: Math.min(CLEANUP_CONCURRENCY, claims.length) },
      worker,
    ),
  );
  if (claims.length > 0) {
    logger.info("templates.deletion_cleanup_complete", {
      cleaned,
      failed,
    });
  }
  if (failed > 0) {
    logger.warn("templates.deletion_cleanup_failed", { failed });
  }
};
