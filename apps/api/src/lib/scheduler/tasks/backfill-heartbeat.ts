import { eq, inArray } from "drizzle-orm";

import {
  backfillHeartbeat,
  type BatchState,
  type Verdict,
} from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

import { databaseBackfillStates, schedulerJobs } from "@/api/db/schema";
import {
  emitSchedulerBackfillHeartbeat,
  SCHEDULER_BACKFILL_CONFIG,
  SCHEDULER_BACKFILL_IDS,
} from "@/api/lib/scheduler/backfill-config";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const BACKFILL_HEARTBEAT_TASK = "backfill.emitHeartbeat" as const;

type PersistedBackfill = {
  id: string;
  enabled: boolean;
  pausedUntil: Date | null;
  batch: Pick<BatchState, "heldSince" | "holdCause"> | null;
};

type PublishBackfillHeartbeatsOptions = {
  rows: readonly PersistedBackfill[];
  now: number;
  emit: typeof emitSchedulerBackfillHeartbeat;
};

export const publishBackfillHeartbeats = ({
  rows,
  now,
  emit,
}: PublishBackfillHeartbeatsOptions) => {
  for (const id of Object.values(SCHEDULER_BACKFILL_IDS)) {
    const row = rows.find((candidate) => candidate.id === id);
    const paused =
      row !== undefined &&
      (!row.enabled ||
        (row.pausedUntil !== null && row.pausedUntil.getTime() > now));
    const batch = row?.batch;
    const unknown = batch === undefined || batch === null;
    const heldSince = row?.batch?.heldSince ?? (paused || unknown ? now : null);
    const kind = (() => {
      if (paused) {
        return "stop";
      }
      if (batch !== undefined && batch !== null && batch.heldSince !== null) {
        return "stop";
      }
      if (unknown) {
        return "unknown";
      }
      return "normal";
    })();
    const reason = (() => {
      if (paused) {
        return "Scheduler job disabled or paused by operator";
      }
      if (batch !== undefined && batch !== null && batch.heldSince !== null) {
        return batch.holdCause === "load"
          ? "Durable backfill load hold"
          : "Durable backfill priority or health hold";
      }
      if (unknown) {
        return "Missing durable backfill checkpoint";
      }
      return "Durable backfill checkpoint is runnable";
    })();
    const verdict: Verdict = {
      kind,
      signals: [],
    };
    emit({
      ...backfillHeartbeat({
        name: id,
        state: { heldSince },
        previousHeldSince: heldSince,
        verdict,
        now,
        config: SCHEDULER_BACKFILL_CONFIG,
      }),
      reason,
    });
  }
};

/** System-only checkpoint and scheduler tables deny ordinary application access. */
export const emitBackfillHeartbeats: SchedulerTask = async ({ db }) => {
  const ids = Object.values(SCHEDULER_BACKFILL_IDS);
  const rows = await db
    .select({
      id: schedulerJobs.id,
      enabled: schedulerJobs.enabled,
      pausedUntil: schedulerJobs.pausedUntil,
      batch: databaseBackfillStates.batch,
    })
    .from(schedulerJobs)
    .leftJoin(
      databaseBackfillStates,
      eq(databaseBackfillStates.name, schedulerJobs.id),
    )
    .where(inArray(schedulerJobs.id, ids))
    .limit(ids.length);
  publishBackfillHeartbeats({
    rows,
    now: Temporal.Now.instant().epochMilliseconds,
    emit: emitSchedulerBackfillHeartbeat,
  });
};
