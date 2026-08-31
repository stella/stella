import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { schedulerJobs } from "@/api/db/schema";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { runWorkAttentionScout } from "@/api/lib/scouts/work-attention";

export const WORK_ATTENTION_SCOUT_TASK =
  "workObligations.attentionScout" as const;

const scoutCursor = (
  payload: Record<string, unknown> | null,
): SafeId<"entity"> | null => {
  const cursor = payload?.["cursor"];
  if (cursor === undefined || cursor === null) {
    return null;
  }
  if (typeof cursor !== "string" || !isUuid(cursor)) {
    return panic("Work-attention scout cursor must be a UUID");
  }
  return brandPersistedEntityId(cursor);
};

/**
 * Sweep one bounded page of governed work for signals a supervisor should see.
 * The cursor advances only after the page's signals are committed, so a failed
 * tick replays the page and the scout's dedupe keys absorb the repeat.
 */
export const runWorkAttentionScoutTask: SchedulerTask = async ({
  job,
  logger,
  signal,
}) => {
  if (!env.FEATURE_GOVERNED_WORKFLOW) {
    return;
  }

  signal.throwIfAborted();
  const leaseToken =
    job.lockedBy ?? panic("Work-attention scout requires a scheduler lease");
  const outcome = await runWorkAttentionScout({
    cursor: scoutCursor(job.payload),
  });

  signal.throwIfAborted();
  await rootDb
    .update(schedulerJobs)
    .set({ payload: { cursor: outcome.nextCursor } })
    .where(
      and(eq(schedulerJobs.id, job.id), eq(schedulerJobs.lockedBy, leaseToken)),
    );

  // audit: skip — an observation sweep over durable work state; the signals it
  // emits carry their own scout_runs census and signal_events trail.
  logger.info("scheduler.work_attention_scanned", {
    "workAttention.emitted": outcome.emitted,
    "workAttention.inserted": outcome.inserted,
    "workAttention.organizations": outcome.organizations,
    "workAttention.organizationsWithoutMember":
      outcome.organizationsWithoutMember,
    "workAttention.scanned": outcome.scanned,
  });
};
