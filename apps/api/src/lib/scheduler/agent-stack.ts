import { TaggedError } from "better-result";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { rootDb } from "@/api/db/root";
import { schedulerJobs } from "@/api/db/schema";
import {
  lockSchedulerRows,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { readTableDigests } from "@/api/lib/dev/seed-seal";
import { runSchedulerOnce } from "@/api/lib/scheduler/runner";
import type {
  SchedulerDb,
  SchedulerTaskRegistry,
} from "@/api/lib/scheduler/types";

const PAUSED_BY = "agent-stack";
const PAUSE_REASON = "Keep seeded screenshot content sealed while idle";

export class AgentSchedulerStateError extends TaggedError(
  "AgentSchedulerStateError",
)<{
  message: string;
}> {}

export const pauseAgentScheduler = async (db: SchedulerDb = rootDb) => {
  // audit: skip - the scheduler pause trigger records the operator attribution.
  await db
    .update(schedulerJobs)
    .set({
      pausedBy: PAUSED_BY,
      pausedUntil: sql`'infinity'::timestamptz`,
      pauseReason: PAUSE_REASON,
    })
    .where(sql`true`);
};

export const resumeAgentScheduler = async (db: SchedulerDb) => {
  // audit: skip - the scheduler pause trigger records the operator attribution.
  await db
    .update(schedulerJobs)
    .set({
      pausedBy: null,
      pausedUntil: null,
      pauseReason: null,
    })
    .where(eq(schedulerJobs.pausedBy, PAUSED_BY));
};

export const assertAgentSchedulerPaused = async (db: SchedulerDb) => {
  const [state] = await db
    .select({
      paused: sql<boolean>`count(*) > 0 AND bool_and(
      coalesce(${schedulerJobs.pausedUntil} = 'infinity'::timestamptz, false)
      AND ${schedulerJobs.lockedBy} IS NULL
    )`,
    })
    .from(schedulerJobs);
  if (state?.paused !== true) {
    throw new AgentSchedulerStateError({
      message:
        "The sealed stack scheduler pause is lifted or a job is still running; run `bun run agent:reset` before agent:drive",
    });
  }
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
  for (const { id } of due) {
    // db-await-in-loop: settle each snapshotted due job once through the scheduler's own lease and execution path
    const result = await runSchedulerOnce({
      db,
      runPausedBy: PAUSED_BY,
      registry,
      jobId: id,
      limit: 1,
    });
    if (result.failed > 0 || result.stoppedBecause === "deadlineReached") {
      throw new AgentSchedulerStateError({
        message: `Scheduler job ${id} did not settle; the agent stack was not sealed`,
      });
    }
  }
};

type SealAgentStackOptions = {
  db?: SchedulerDb;
  registry: SchedulerTaskRegistry;
  sealPath: string;
};

export const sealAgentStack = async ({
  db = rootDb,
  registry,
  sealPath,
}: SealAgentStackOptions) => {
  await assertAgentSchedulerPaused(db);
  await settleAgentScheduler({ db, registry });
  await withAggregateTransaction(db, async (tx) => {
    // All settled jobs are paused again. Fence the short fingerprint phase
    // against an explicit resume until the seal and final pause commit.
    await lockSchedulerRows(tx);
    await assertAgentSchedulerPaused(tx);
    const digests = await readTableDigests(tx);
    mkdirSync(path.dirname(sealPath), { recursive: true });
    writeFileSync(sealPath, `${JSON.stringify(digests, null, 2)}\n`);
    await pauseAgentScheduler(tx);
    await assertAgentSchedulerPaused(tx);
  });
};
