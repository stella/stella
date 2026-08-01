import { panic } from "better-result";
import { and, eq, gt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { entities, schedulerJobs, workObligations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { legacyWorkObligationValues } from "@/api/lib/work-obligations/legacy-work-obligation";

export const BACKFILL_WORK_OBLIGATIONS_TASK =
  "workObligations.backfillLegacyTasks" as const;

const BACKFILL_LIMIT = 1000;

type BackfillState = {
  cursor: SafeId<"entity"> | null;
  pass: number;
};

const backfillState = (
  payload: Record<string, unknown> | null,
): BackfillState => {
  const cursor = payload?.["cursor"];
  const pass = payload?.["pass"];
  if (
    cursor !== undefined &&
    cursor !== null &&
    (typeof cursor !== "string" || !isUuid(cursor))
  ) {
    return panic("Work-obligation backfill cursor must be a UUID");
  }
  if (pass !== undefined && pass !== 0 && pass !== 1) {
    return panic("Work-obligation backfill pass must be 0 or 1");
  }
  return {
    cursor: typeof cursor === "string" ? brandPersistedEntityId(cursor) : null,
    pass: pass ?? 0,
  };
};

/**
 * Repair one bounded page. The missing target row is the durable work queue:
 * replay and overlapping selection converge through the entity-id primary key.
 */
export const backfillWorkObligations: SchedulerTask = async ({
  job,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  const state = backfillState(job.payload);
  const leaseToken =
    job.lockedBy ??
    panic("Work-obligation backfill requires a scheduler lease");
  const outcome = await rootDb.transaction(async (tx) => {
    const tasks = await tx
      .select({
        id: entities.id,
        workspaceId: entities.workspaceId,
        agendaKind: entities.agendaKind,
        agendaSource: entities.agendaSource,
        status: entities.status,
        dueDate: entities.dueDate,
        createdBy: entities.createdBy,
        createdAt: entities.createdAt,
        updatedAt: entities.updatedAt,
      })
      .from(entities)
      .where(
        and(
          eq(entities.kind, "task"),
          state.cursor === null ? undefined : gt(entities.id, state.cursor),
        ),
      )
      .orderBy(entities.id)
      .limit(BACKFILL_LIMIT);

    signal.throwIfAborted();
    const lastTask = tasks.at(-1);
    if (!lastTask) {
      if (state.pass === 0) {
        await tx
          .update(schedulerJobs)
          .set({ payload: { cursor: null, pass: 1 } })
          .where(
            and(
              eq(schedulerJobs.id, job.id),
              eq(schedulerJobs.lockedBy, leaseToken),
            ),
          );
        return { status: "replay" as const, inserted: 0, scanned: 0 };
      }

      await tx
        .update(schedulerJobs)
        .set({ enabled: false })
        .where(
          and(
            eq(schedulerJobs.id, job.id),
            eq(schedulerJobs.lockedBy, leaseToken),
          ),
        );
      return { status: "complete" as const, inserted: 0, scanned: 0 };
    }

    const inserted = await tx
      .insert(workObligations)
      .values(tasks.map(legacyWorkObligationValues))
      .onConflictDoNothing({ target: workObligations.entityId })
      .returning({ entityId: workObligations.entityId });

    // Checkpoint last and in the same transaction as the idempotent inserts.
    await tx
      .update(schedulerJobs)
      .set({ payload: { cursor: lastTask.id, pass: state.pass } })
      .where(
        and(
          eq(schedulerJobs.id, job.id),
          eq(schedulerJobs.lockedBy, leaseToken),
        ),
      );
    return {
      status: "progress" as const,
      inserted: inserted.length,
      scanned: tasks.length,
    };
  });

  // audit: skip — bounded compatibility repair derived from existing tasks;
  // scheduler_job_runs provides the durable operator trail.
  logger.info("scheduler.work_obligations_backfilled", {
    "workObligations.inserted": outcome.inserted,
    "workObligations.scanned": outcome.scanned,
    "workObligations.status": outcome.status,
  });
};
