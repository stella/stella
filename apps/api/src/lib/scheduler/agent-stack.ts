import { Result, TaggedError } from "better-result";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { schedulerJobs } from "@/api/db/schema";
import {
  lockSchedulerRows,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { updateSchedulerPause } from "@/api/lib/scheduler/pauses";
import { runSchedulerOnce } from "@/api/lib/scheduler/runner";
import { readTableDigests } from "@/api/lib/scheduler/seed-seal";
import type {
  SchedulerDb,
  SchedulerMaintenanceDb,
  SchedulerTaskRegistry,
} from "@/api/lib/scheduler/types";

const PAUSED_BY = "agent-stack";
const PAUSE_REASON = "Keep seeded screenshot content sealed while idle";

export class AgentSchedulerStateError extends TaggedError(
  "AgentSchedulerStateError",
)<{
  message: string;
}> {}

export const pauseAgentScheduler = async (db: SchedulerMaintenanceDb) =>
  await updateSchedulerPause(db, {
    type: "pause",
    pausedBy: PAUSED_BY,
    pauseReason: PAUSE_REASON,
  });

export const resumeAgentScheduler = async (db: SchedulerMaintenanceDb) =>
  await updateSchedulerPause(db, { type: "resume", pausedBy: PAUSED_BY });

export const assertAgentSchedulerPaused = async (
  db: SchedulerMaintenanceDb,
) => {
  const [state] = await db
    .select({
      paused: sql<boolean>`count(*) > 0 AND bool_and(
      coalesce(${schedulerJobs.pausedUntil} = 'infinity'::timestamptz, false)
      AND ${schedulerJobs.lockedBy} IS NULL
    )`,
    })
    .from(schedulerJobs);
  if (state?.paused !== true) {
    return Result.err(
      new AgentSchedulerStateError({
        message:
          "The sealed stack scheduler pause is lifted or a job is still running; run `bun run agent:reset` before agent:drive",
      }),
    );
  }
  return Result.ok(undefined);
};

type SettleAgentSchedulerOptions = {
  db: SchedulerDb;
  registry: SchedulerTaskRegistry;
};

// Each one-shot claim lifts only its own pause atomically with its lease.
// Completion restores the pause before the background loop can claim it.
export const settleAgentScheduler = async ({
  db,
  registry,
}: SettleAgentSchedulerOptions) => {
  const due = await db
    .select({ id: schedulerJobs.id })
    .from(schedulerJobs)
    .where(
      and(
        eq(schedulerJobs.enabled, true),
        inArray(schedulerJobs.task, [...registry.keys()]),
        lte(schedulerJobs.nextRunAt, sql`now()`),
      ),
    );
  if (due.length === 0) {
    return Result.ok(undefined);
  }
  const result = await runSchedulerOnce({
    db,
    runPausedBy: PAUSED_BY,
    registry,
    jobIds: due.map(({ id }) => id),
    limit: due.length,
  });
  if (result.failed > 0 || result.acquired !== due.length) {
    return Result.err(
      new AgentSchedulerStateError({
        message:
          "Scheduler jobs did not settle; the agent stack was not sealed",
      }),
    );
  }
  return Result.ok(undefined);
};

export type SealAgentStackOptions = {
  registry: SchedulerTaskRegistry;
  sealPath: string;
};

export const sealAgentStack = async (
  db: SchedulerDb,
  { registry, sealPath }: SealAgentStackOptions,
) => {
  const paused = await assertAgentSchedulerPaused(db);
  if (paused.isErr()) {
    return paused;
  }
  const settled = await settleAgentScheduler({ db, registry });
  if (settled.isErr()) {
    return settled;
  }
  return await withAggregateTransaction(db, async (tx) => {
    // All settled jobs are paused again. Fence the short fingerprint phase
    // against an explicit resume until the seal and final pause commit.
    await lockSchedulerRows(tx);
    const fenced = await assertAgentSchedulerPaused(tx);
    if (fenced.isErr()) {
      return fenced;
    }
    const digests = await readTableDigests(tx);
    mkdirSync(path.dirname(sealPath), { recursive: true });
    writeFileSync(sealPath, `${JSON.stringify(digests, null, 2)}\n`);
    await pauseAgentScheduler(tx);
    return await assertAgentSchedulerPaused(tx);
  });
};
