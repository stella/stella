import { Result } from "better-result";
import { asc, sql } from "drizzle-orm";

import { sanctionsContactMarks } from "@/api/db/schema";
import {
  drainSanctionsContactMarks,
  SanctionsDrainAttemptFailed,
} from "@/api/lib/lists/sanctions/monitoring-drain";
import { createRootOrganizationBackgroundDb } from "@/api/lib/root-scoped-db";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const DRAIN_SANCTIONS_MONITORING_TASK =
  "sanctions.drainMonitoring" as const;

const MONITORING_ORGANIZATIONS_PER_RUN = 8;

export const drainSanctionsMonitoringTask: SchedulerTask = async ({
  db,
  signal,
  dueAt,
  logger,
  scheduleContinuation,
}) => {
  signal.throwIfAborted();
  const now = dueAt.claimedAtDate();
  // The system connection discovers only the next queued tenant; contact data stays on stella/RLS.
  const pending = await db
    .select({ organizationId: sanctionsContactMarks.organizationId })
    .from(sanctionsContactMarks)
    .where(
      sql`${sanctionsContactMarks.scheduledAt} <= ${now}::timestamptz AND ${sanctionsContactMarks.nextAttemptAt} <= ${now}::timestamptz`,
    )
    .groupBy(sanctionsContactMarks.organizationId)
    .orderBy(
      sql`min(${sanctionsContactMarks.nextAttemptAt})`,
      sql`min(${sanctionsContactMarks.scheduledAt})`,
      asc(sanctionsContactMarks.organizationId),
    )
    .limit(MONITORING_ORGANIZATIONS_PER_RUN);
  let claimed = 0;
  const drainNext = async (
    index: number,
  ): Promise<Result<void, SchedulerTaskFailure>> => {
    signal.throwIfAborted();
    const organization = pending.at(index);
    if (organization === undefined) {
      return Result.ok(undefined);
    }
    const outcome = await drainSanctionsContactMarks({
      db: createRootOrganizationBackgroundDb(organization.organizationId),
      organizationId: organization.organizationId,
      now,
      signal,
    });
    if (outcome.isErr()) {
      signal.throwIfAborted();
      if (!SanctionsDrainAttemptFailed.is(outcome.error)) {
        return Result.err(
          new SchedulerTaskFailure({
            message: "Sanctions drain could not record its retry",
            cause: outcome.error,
          }),
        );
      }
      logger.warn("scheduler.sanctions_monitoring_drain_failed", {
        "sanctions.failure_code": "attempt-backed-off",
      });
    } else {
      claimed += outcome.value.claimed;
      logger.info("scheduler.sanctions_monitoring_drained", {
        "sanctions.claimed": outcome.value.claimed,
        "sanctions.terminal": outcome.value.terminal,
      });
    }
    return await drainNext(index + 1);
  };
  const outcome = await drainNext(0);
  if (outcome.isErr()) {
    return outcome;
  }
  if (claimed > 0) {
    scheduleContinuation(new Date(now.getTime() + 1000));
  }
  return outcome;
};
