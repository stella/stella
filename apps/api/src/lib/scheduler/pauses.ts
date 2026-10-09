import { panic } from "better-result";
import { and, eq, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { schedulerJobs } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  lockSchedulerRows,
  withAggregateSavepoint,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import type { SchedulerMaintenanceDb } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

const AUDIT_ACTOR = "system:scheduler-pauses";

type SchedulerPauseChange =
  | { type: "pause"; pausedBy: string; pauseReason: string }
  | { type: "resume"; pausedBy: string };

/** Persist pause transitions and their audit row in the same transaction. */
export const updateSchedulerPause = async (
  db: SchedulerMaintenanceDb,
  change: SchedulerPauseChange,
) => {
  const apply = async (tx: Transaction) => {
    await lockSchedulerRows(tx);
    switch (change.type) {
      case "pause": {
        // An existing indefinite operator pause already freezes this job.
        const changed = await tx
          .update(schedulerJobs)
          .set({
            pausedBy: change.pausedBy,
            pauseReason: change.pauseReason,
            pausedUntil: sql`'infinity'::timestamptz`,
          })
          .where(
            sql`${schedulerJobs.pausedUntil} IS DISTINCT FROM 'infinity'::timestamptz`,
          )
          .returning({ id: schedulerJobs.id });
        await recordSystemAudit(tx, AUDIT_ACTOR, {
          subject: createSafeId<"systemScriptRun">(),
          counts: { pausedJobs: changed.length, resumedJobs: 0 },
        });
        return;
      }
      case "resume": {
        const changed = await tx
          .update(schedulerJobs)
          .set({ pausedBy: null, pauseReason: null, pausedUntil: null })
          .where(
            and(
              eq(schedulerJobs.pausedBy, change.pausedBy),
              or(
                sql`${schedulerJobs.pausedUntil} IS NOT NULL`,
                sql`${schedulerJobs.pauseReason} IS NOT NULL`,
              ),
            ),
          )
          .returning({ id: schedulerJobs.id });
        await recordSystemAudit(tx, AUDIT_ACTOR, {
          subject: createSafeId<"systemScriptRun">(),
          counts: { pausedJobs: 0, resumedJobs: changed.length },
        });
        return;
      }
      default:
        change satisfies never;
        return panic("Unknown scheduler pause change");
    }
  };
  // A seal already owns its census transaction; its audit shares that commit.
  if ("rollback" in db) {
    await withAggregateSavepoint(db, apply);
    return;
  }
  await withAggregateTransaction(db, apply);
};
