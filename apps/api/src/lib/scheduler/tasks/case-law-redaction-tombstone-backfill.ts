import { panic } from "better-result";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawIndexJobs,
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

    // audit: skip — bounded compatibility repair derived from append-only
    // redaction audit rows.
    const repaired = await tx
      .update(caseLawDecisions)
      .set({
        redactedAt: sql`(
          SELECT max(${caseLawIndexJobs.createdAt})
          FROM ${caseLawIndexJobs}
          WHERE ${caseLawIndexJobs.decisionId} = ${caseLawDecisions.id}
            AND ${caseLawIndexJobs.operation} = 'redact'
        )`,
      })
      .where(
        and(
          inArray(caseLawDecisions.id, decisionIds),
          isNull(caseLawDecisions.redactedAt),
          isNull(caseLawDecisions.fulltext),
          isNull(caseLawDecisions.sections),
          isNull(caseLawDecisions.documentAst),
          isNull(caseLawDecisions.contentHash),
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
