import { asc, sql } from "drizzle-orm";

import { sanctionsContactMarks } from "@/api/db/schema";
import { drainSanctionsContactMarks } from "@/api/lib/lists/sanctions/monitoring-drain";
import { createRootOrganizationBackgroundDb } from "@/api/lib/root-scoped-db";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const DRAIN_SANCTIONS_MONITORING_TASK =
  "sanctions.drainMonitoring" as const;

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
  const pending = (
    await db
      .select({ organizationId: sanctionsContactMarks.organizationId })
      .from(sanctionsContactMarks)
      .where(sql`${sanctionsContactMarks.scheduledAt} <= ${now}::timestamptz`)
      .orderBy(
        asc(sanctionsContactMarks.scheduledAt),
        asc(sanctionsContactMarks.organizationId),
      )
      .limit(1)
  ).at(0);
  if (pending === undefined) {
    return;
  }
  const outcome = await drainSanctionsContactMarks({
    db: createRootOrganizationBackgroundDb(pending.organizationId),
    organizationId: pending.organizationId,
    now,
    signal,
  });
  logger.info("scheduler.sanctions_monitoring_drained", {
    "sanctions.claimed": outcome.claimed,
    "sanctions.terminal": outcome.terminal,
  });
  if (outcome.claimed > 0) {
    scheduleContinuation(new Date(now.getTime() + 1000));
  }
};
