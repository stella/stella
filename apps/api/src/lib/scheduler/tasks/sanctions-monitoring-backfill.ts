import { and, asc, eq, sql } from "drizzle-orm";

import { sanctionsMonitoringBackfills } from "@/api/db/schema";
import { advanceSanctionsMonitoringBackfill } from "@/api/lib/lists/sanctions/monitoring-backfill";
import { queueSanctionsMonitoringBackfills } from "@/api/lib/lists/sanctions/monitoring-fanout";
import { createRootOrganizationBackgroundDb } from "@/api/lib/root-scoped-db";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const BACKFILL_SANCTIONS_MONITORING_TASK =
  "sanctions.backfillMonitoring" as const;

export const backfillSanctionsMonitoringTask: SchedulerTask = async ({
  db,
  runId,
  signal,
  dueAt,
  logger,
  scheduleContinuation,
}) => {
  signal.throwIfAborted();
  const now = dueAt.claimedAtDate();
  const { requested, fanned } = await queueSanctionsMonitoringBackfills({
    db,
    now,
    runId,
  });
  signal.throwIfAborted();
  const pending = (
    await db
      .select({
        organizationId: sanctionsMonitoringBackfills.organizationId,
        sourceId: sanctionsMonitoringBackfills.sourceId,
      })
      .from(sanctionsMonitoringBackfills)
      .where(
        and(
          eq(sanctionsMonitoringBackfills.status, "pending"),
          sql`${sanctionsMonitoringBackfills.scheduledAt} <= ${now}::timestamptz`,
        ),
      )
      .orderBy(
        asc(sanctionsMonitoringBackfills.scheduledAt),
        asc(sanctionsMonitoringBackfills.organizationId),
        asc(sanctionsMonitoringBackfills.sourceId),
      )
      .limit(1)
  ).at(0);
  const outcome =
    pending === undefined
      ? "idle"
      : await advanceSanctionsMonitoringBackfill({
          db: createRootOrganizationBackgroundDb(pending.organizationId),
          organizationId: pending.organizationId,
          sourceId: pending.sourceId,
          now,
          signal,
        });
  logger.info("scheduler.sanctions_monitoring_backfill", {
    "sanctions.organization_requests": requested,
    "sanctions.organizations_fanned": fanned,
    "sanctions.outcome": outcome,
  });
  if (
    requested > 0 ||
    fanned > 0 ||
    outcome === "advanced" ||
    outcome === "superseded"
  ) {
    scheduleContinuation(new Date(now.getTime() + 1000));
  }
};
