import { panic } from "better-result";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS,
  caseLawCorpusUploadIntents,
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSearchDocuments,
  schedulerJobs,
} from "@/api/db/schema";
import { isUuid } from "@/api/lib/custom-schema";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK =
  "caseLaw.backfillRedactionTombstones" as const;

const BACKFILL_LIMIT = 100;

const parseCursor = (
  payload: Record<string, unknown> | null,
): string | null => {
  const value = payload?.["cursor"];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !isUuid(value)) {
    return panic("Case-law redaction tombstone cursor must be a UUID");
  }
  return value;
};

/**
 * One bounded, checkpointed pass over historical redaction audits. New audit
 * rows are fenced by migration triggers, so the job disables itself after the
 * immutable historical range reaches a fixed point.
 */
export const backfillCaseLawRedactionTombstones: SchedulerTask = async ({
  job,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  const cursor = parseCursor(job.payload);
  const leaseToken =
    job.lockedBy ??
    panic("Case-law redaction tombstone backfill requires a scheduler lease");

  const outcome = await rootDb.transaction(async (tx) => {
    const page = await tx
      .selectDistinct({ decisionId: caseLawIndexJobs.decisionId })
      .from(caseLawIndexJobs)
      .where(
        and(
          eq(caseLawIndexJobs.operation, "redact"),
          sql`${caseLawIndexJobs.decisionId} IS NOT NULL`,
          cursor === null
            ? undefined
            : sql`${caseLawIndexJobs.decisionId} > ${cursor}`,
        ),
      )
      .orderBy(caseLawIndexJobs.decisionId)
      .limit(BACKFILL_LIMIT);
    const decisionIds = page.flatMap(({ decisionId }) =>
      decisionId === null ? [] : [decisionId],
    );
    const lastDecisionId = decisionIds.at(-1);
    if (!lastDecisionId) {
      // audit: skip — disables a versioned one-shot repair; scheduler job runs
      // retain the operator trail.
      await tx
        .update(schedulerJobs)
        .set({ enabled: false })
        .where(
          and(
            eq(schedulerJobs.id, job.id),
            eq(schedulerJobs.lockedBy, leaseToken),
          ),
        );
      return { status: "complete" as const, repaired: 0 };
    }

    const repairRows = await tx
      .select({
        astKey: caseLawDecisions.astS3Key,
        id: caseLawDecisions.id,
        sectionsKey: caseLawDecisions.normalizedS3Key,
        textKey: caseLawDecisions.textS3Key,
      })
      .from(caseLawDecisions)
      .where(
        and(
          inArray(caseLawDecisions.id, decisionIds),
          isNull(caseLawDecisions.redactedAt),
        ),
      )
      .for("update");
    const repairIds = repairRows.map(({ id }) => id);
    const now = new Date();

    if (repairIds.length > 0) {
      // Any upload that reserved before this row lock becomes cleanup work;
      // settlement rechecks the tombstone after acquiring the same lock.
      await tx
        .update(caseLawCorpusUploadIntents)
        .set({
          status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
          nextCleanupAt: now,
        })
        .where(
          and(
            inArray(caseLawCorpusUploadIntents.decisionId, repairIds),
            eq(
              caseLawCorpusUploadIntents.status,
              CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
            ),
          ),
        );

      const pointerCleanupRows = repairRows.flatMap(
        ({ astKey, id, sectionsKey, textKey }) => {
          const fallbackKey = textKey ?? sectionsKey ?? astKey;
          return fallbackKey === null
            ? []
            : [
                {
                  astS3Key: astKey ?? fallbackKey,
                  decisionId: id,
                  leaseExpiresAt: now,
                  nextCleanupAt: now,
                  normalizedS3Key: sectionsKey ?? fallbackKey,
                  status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
                  textS3Key: textKey ?? fallbackKey,
                },
              ];
        },
      );
      if (pointerCleanupRows.length > 0) {
        await tx.insert(caseLawCorpusUploadIntents).values(pointerCleanupRows);
      }
    }

    // The audit is authoritative even if pre-fence ingestion restored a
    // historical payload. Own every object key durably, remove projections
    // for the full audit page (including rows repaired by v1), then scrub the
    // row in the same transaction so no restored content remains readable.
    // audit: skip — bounded compatibility repair derived from append-only
    // redaction audit rows.
    if (decisionIds.length > 0) {
      await tx
        .delete(caseLawSearchDocuments)
        .where(inArray(caseLawSearchDocuments.decisionId, decisionIds));
    }
    const repaired =
      repairIds.length === 0
        ? []
        : await tx
            .update(caseLawDecisions)
            .set({
              astS3Key: null,
              corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
              contentHash: null,
              documentAst: null,
              fulltext: null,
              indexedAt: null,
              indexedHash: null,
              normalizedS3Key: null,
              redactedAt: sql`(
                SELECT max(${caseLawIndexJobs.createdAt})
                FROM ${caseLawIndexJobs}
                WHERE ${caseLawIndexJobs.decisionId} = ${caseLawDecisions.id}
                  AND ${caseLawIndexJobs.operation} = 'redact'
              )`,
              sections: null,
              textS3Key: null,
            })
            .where(
              and(
                inArray(caseLawDecisions.id, repairIds),
                isNull(caseLawDecisions.redactedAt),
              ),
            )
            .returning({ id: caseLawDecisions.id });

    // Checkpoint last: replaying the same page is idempotent, while advancing
    // first could permanently skip a failed tombstone update.
    await tx
      .update(schedulerJobs)
      .set({ payload: { cursor: lastDecisionId } })
      .where(
        and(
          eq(schedulerJobs.id, job.id),
          eq(schedulerJobs.lockedBy, leaseToken),
        ),
      );
    return { status: "progress" as const, repaired: repaired.length };
  });

  logger.info("scheduler.case_law_redaction_tombstones_backfilled", {
    "caseLawRedactionTombstones.repaired": outcome.repaired,
    "caseLawRedactionTombstones.status": outcome.status,
  });
};
