import { Result } from "better-result";
import { asc, sql } from "drizzle-orm";

import { sanctionsContactMarks } from "@/api/db/schema";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import {
  drainSanctionsContactMarks,
  SanctionsDrainAttemptFailed,
} from "@/api/lib/lists/sanctions/monitoring-drain";
import { createRootOrganizationBackgroundDb } from "@/api/lib/root-scoped-db";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";

export const DRAIN_SANCTIONS_MONITORING_TASK =
  "sanctions.drainMonitoring" as const;

const MONITORING_ORGANIZATIONS_PER_RUN = 8;

export const createDrainSanctionsMonitoringTask =
  (drain: typeof drainSanctionsContactMarks = drainSanctionsContactMarks) =>
  async ({
    db,
    signal,
    dueAt,
    logger,
    scheduleContinuation,
  }: SchedulerTaskContext) => {
    signal.throwIfAborted();
    const now = dueAt.claimedAtDate();
    // The system connection discovers only the next queued tenant; contact data stays on stella/RLS.
    const page = await readCursorPage(
      db
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
        ),
      {
        limit: MONITORING_ORGANIZATIONS_PER_RUN,
        cursorForItem: (row) => row.organizationId,
      },
    );
    const pending = page.items;
    const continuation = { required: page.nextCursor !== null };
    let claimed = 0;
    const failures: unknown[] = [];
    const drainNext = async (index: number): Promise<void> => {
      signal.throwIfAborted();
      const organization = pending.at(index);
      if (organization === undefined) {
        return;
      }
      const outcome = await drain({
        db: createRootOrganizationBackgroundDb(organization.organizationId),
        organizationId: organization.organizationId,
        now,
        signal,
      });
      if (outcome.isErr()) {
        signal.throwIfAborted();
        const backedOff = SanctionsDrainAttemptFailed.is(outcome.error);
        if (!backedOff) {
          failures.push(outcome.error);
        }
        logger.warn("scheduler.sanctions_monitoring_drain_failed", {
          "sanctions.failure_code": backedOff
            ? "attempt-backed-off"
            : "unrecorded",
        });
      } else {
        claimed += outcome.value.claimed;
        continuation.required ||= outcome.value.hasMore;
        logger.info("scheduler.sanctions_monitoring_drained", {
          "sanctions.claimed": outcome.value.claimed,
          "sanctions.terminal": outcome.value.terminal,
        });
      }
      await drainNext(index + 1);
    };
    await drainNext(0);
    if (claimed > 0 || continuation.required) {
      scheduleContinuation(new Date(now.getTime() + 1000));
    }
    if (failures.length > 0) {
      return Result.err(
        new SchedulerTaskFailure({
          message: "Sanctions drain failed for one or more organizations",
          cause: failures,
        }),
      );
    }
    return Result.ok(undefined);
  };

export const drainSanctionsMonitoringTask =
  createDrainSanctionsMonitoringTask();
