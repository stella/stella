import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { OrgScopedTransaction } from "@/api/db/org-scope";
import type { ScopedTransaction } from "@/api/db/safe-db";
import type { SchedulerPayload, SchedulerSchedule } from "@/api/db/schema";
import { schedulerJobs } from "@/api/db/schema";
import {
  type PlatformRunnerFinishState,
  type PlatformSchedulerState,
  type SchedulerOperatorPauseRow,
  type SchedulerOperatorPauseState,
  type SearchSemanticTimestampsState,
  writeSchedulerBookkeeping,
} from "@/api/lib/db/recovery-bookkeeping/scheduler";
import type { JsonObject } from "@/api/lib/json-value";
import type { RegisteredSchedulerTaskName } from "@/api/lib/scheduler/registry";
import { computeNextRunAt } from "@/api/lib/scheduler/schedule";
import type { SchedulerTaskWithOwnership } from "@/api/lib/scheduler/task-authority";
import type { RECOVERY_SCAN_IDENTITIES } from "@/api/lib/scheduler/tasks/recovery-scan-identity";
import type { SchedulerDb, SchedulerJob } from "@/api/lib/scheduler/types";

export type SchedulerJobDefinition<
  Task extends RegisteredSchedulerTaskName =
    SchedulerTaskWithOwnership<"platform">,
> = {
  id: string;
  task: Task;
  description: string;
  schedule: SchedulerSchedule;
  payload?: JsonObject | null;
  payloadUpdate?: "preserve" | "replace";
  enabled?: boolean;
  /**
   * When a job's row is first created. `after-interval` (the default) waits
   * one full interval; `on-registration` is due at once, for a job whose
   * output readers depend on (a snapshot) and which must not leave a fresh
   * deployment without it for a whole interval. Either way the runner's claim
   * decides which replica runs it, so only one does.
   */
  firstRun?: "after-interval" | "on-registration";
};

/** The `nextRunAt` a job row is created with. */
export const initialNextRunAt = (
  {
    firstRun = "after-interval",
    schedule,
  }: SchedulerJobDefinition<RegisteredSchedulerTaskName>,
  now: Date,
): Date =>
  firstRun === "on-registration" ? now : computeNextRunAt(schedule, now);

export const schedulerSchedulesEqual = (
  left: SchedulerSchedule,
  right: SchedulerSchedule,
): boolean => {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "interval" && right.type === "interval") {
    return left.everyMs === right.everyMs;
  }

  if (left.type !== "daily" || right.type !== "daily") {
    return false;
  }

  return (
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.timeZone === right.timeZone
  );
};

type UpsertSchedulerJobOptions =
  | {
      ownership: "platform";
      definition: SchedulerJobDefinition;
      db: Pick<ScopedTransaction, "select" | "execute">;
    }
  | {
      ownership: "organization";
      definition: SchedulerJobDefinition<
        SchedulerTaskWithOwnership<"organization">
      >;
      db: OrgScopedTransaction;
    };

export const upsertSchedulerJob = async (
  options: UpsertSchedulerJobOptions,
): Promise<void> => {
  const { definition } = options;
  const db = options.ownership === "organization" ? options.db.tx : options.db;
  const {
    description,
    enabled = true,
    id,
    payload = null,
    payloadUpdate = "replace",
    schedule,
    task,
  } = definition;
  const now = new Date();
  const [existingJob] = await db
    .select({
      schedule: schedulerJobs.schedule,
      task: schedulerJobs.task,
    })
    .from(schedulerJobs)
    .where(eq(schedulerJobs.id, id))
    .limit(1);
  const shouldRefreshNextRunAt =
    !existingJob ||
    existingJob.task !== task ||
    !schedulerSchedulesEqual(existingJob.schedule, schedule);

  const values = {
    description,
    enabled,
    id,
    nextRunAt: initialNextRunAt(definition, now),
    payload,
    schedule,
  };
  const bookkeeping = {
    type: "upsert",
    table: schedulerJobs,
    refreshedNextRunAt: shouldRefreshNextRunAt
      ? computeNextRunAt(schedule, now)
      : null,
    replacePayload: payloadUpdate === "replace",
  } as const;
  switch (options.ownership) {
    case "organization":
      await writeSchedulerBookkeeping({
        ...bookkeeping,
        ownership: "organization",
        db: options.db,
        values: { ...values, task: options.definition.task },
      });
      return;
    case "platform":
      await writeSchedulerBookkeeping({
        ...bookkeeping,
        ownership: "platform",
        db: options.db,
        values: { ...values, task: options.definition.task },
      });
      return;
    default:
      options satisfies never;
      return panic("Unknown scheduler row ownership");
  }
};

export type PlatformSchedulerTaskState = PlatformSchedulerState;

type PlatformSchedulerStateOptions = {
  db: Pick<ScopedTransaction, "update">;
  task: SchedulerTaskWithOwnership<"platform">;
  jobId: string;
  leaseToken: string;
  state: PlatformSchedulerTaskState;
};

/** Checkpoint or retire a canonical platform task under its exact live lease. */
export const writePlatformSchedulerTaskState = async ({
  db,
  jobId,
  leaseToken,
  state,
  task,
}: PlatformSchedulerStateOptions): Promise<void> => {
  await writeSchedulerBookkeeping({
    type: "platform-state",
    db,
    jobId,
    lockedBy: leaseToken,
    state,
    task,
    table: schedulerJobs,
  });
};

type CompleteAgentClientStorageOptions = {
  db: Pick<ScopedTransaction, "update">;
  expectedPayload: SchedulerPayload | null;
  jobId: string;
};

/** Retire the storage backfill only while its original payload still matches. */
export const completeAgentClientStorageJob = async ({
  db,
  expectedPayload,
  jobId,
}: CompleteAgentClientStorageOptions): Promise<void> => {
  await writeSchedulerBookkeeping({
    type: "agent-client-storage-complete",
    db,
    expectedPayload,
    jobId,
    table: schedulerJobs,
    task: "agentClients.backfillStorage",
  });
};

export const registerOneShotSchedulerJob = async ({
  db,
  definition,
}: {
  db: Pick<ScopedTransaction, "execute">;
  definition: SchedulerJobDefinition;
}): Promise<void> => {
  const now = new Date();
  await writeSchedulerBookkeeping({
    type: "platform-register-one-shot",
    table: schedulerJobs,
    db,
    values: {
      description: definition.description,
      enabled: true,
      id: definition.id,
      nextRunAt: computeNextRunAt(definition.schedule, now),
      payload: definition.payload ?? null,
      schedule: definition.schedule,
      task: definition.task,
    },
  });
};

export const claimPlatformSchedulerJob = async ({
  db,
  runnableTasks,
  excludeJobIds,
  eligibilityAt,
  leaseToken,
  leaseMs,
}: {
  db: SchedulerDb;
  runnableTasks: readonly string[];
  excludeJobIds: readonly string[];
  eligibilityAt: Date | null;
  leaseToken: string;
  leaseMs: number;
}): Promise<SchedulerJob | null> =>
  await writeSchedulerBookkeeping({
    type: "platform-runner-claim",
    table: schedulerJobs,
    db,
    runnableTasks,
    excludeJobIds,
    eligibilityAt,
    leaseToken,
    leaseMs,
  });

export const renewPlatformSchedulerJobLease = async ({
  db,
  jobId,
  leaseToken,
  leaseMs,
}: {
  db: Pick<ScopedTransaction, "update">;
  jobId: string;
  leaseToken: string;
  leaseMs: number;
}): Promise<{ id: string }[]> =>
  await writeSchedulerBookkeeping({
    type: "platform-runner-renew",
    table: schedulerJobs,
    db,
    jobId,
    leaseToken,
    leaseMs,
  });

export const finishPlatformSchedulerJob = async ({
  db,
  jobId,
  leaseToken,
  state,
}: {
  db: Pick<ScopedTransaction, "update">;
  jobId: string;
  leaseToken: string;
  state: PlatformRunnerFinishState;
}): Promise<void> =>
  await writeSchedulerBookkeeping({
    type: "platform-runner-finish",
    table: schedulerJobs,
    db,
    jobId,
    leaseToken,
    state,
  });

export const boundPlatformSchedulerPauses = async (
  db: Pick<ScopedTransaction, "update">,
): Promise<{ id: string; pausedUntil: Date | null }[]> =>
  await writeSchedulerBookkeeping({
    type: "platform-bound-pauses",
    table: schedulerJobs,
    db,
  });

export const retireUnknownPlatformSchedulerJobs = async (
  db: Pick<ScopedTransaction, "update">,
): Promise<{ id: string; task: string }[]> =>
  await writeSchedulerBookkeeping({
    type: "platform-retire-unknown-tasks",
    table: schedulerJobs,
    db,
  });

type CheckpointRecoverySchedulerJobOptions = {
  db: Pick<ScopedTransaction, "update">;
  task: (typeof RECOVERY_SCAN_IDENTITIES)[keyof typeof RECOVERY_SCAN_IDENTITIES]["task"];
  jobId: string;
  leaseToken: string;
  scan: JsonObject;
};

/** Persist both recovery positions only for the task's current lease. */
export const checkpointRecoverySchedulerJob = async ({
  db,
  task,
  jobId,
  leaseToken,
  scan,
}: CheckpointRecoverySchedulerJobOptions): Promise<boolean> => {
  const changed = await writeSchedulerBookkeeping({
    type: "recovery-scan-checkpoint",
    table: schedulerJobs,
    db,
    task,
    jobId,
    lockedBy: leaseToken,
    scan,
  });
  return changed.length === 1;
};

export type SchedulerJobOperatorPauseState = SchedulerOperatorPauseState;

export const writeSchedulerJobOperatorPause = async ({
  db,
  jobId,
  state,
}: {
  db: Pick<ScopedTransaction, "execute">;
  jobId: string;
  state: SchedulerJobOperatorPauseState;
}): Promise<SchedulerOperatorPauseRow[]> =>
  await writeSchedulerBookkeeping({
    type: "operator-pause",
    table: schedulerJobs,
    db,
    jobId,
    state,
  });

export const writeSearchSemanticTimestampsState = async ({
  db,
  jobId,
  leaseToken,
  state,
}: {
  db: Pick<SchedulerDb, "execute">;
  jobId: string;
  leaseToken: string;
  state: SearchSemanticTimestampsState;
}): Promise<void> =>
  await writeSchedulerBookkeeping({
    type: "search-semantic-state",
    task: "search.repairSemanticTimestamps",
    table: schedulerJobs,
    db,
    jobId,
    lockedBy: leaseToken,
    state,
  });
