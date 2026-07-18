import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { desc, eq } from "drizzle-orm";

import type { SchedulerSchedule } from "@/api/db/schema";
import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  acquireDueJobs,
  finishRunFailure,
  finishRunSkipped,
  finishRunSuccess,
  runSchedulerOnce,
  type SchedulerDb,
} from "./runner";
import type { SchedulerTask, SchedulerTaskRegistry } from "./types";

// leaseMs has a hard floor of three poll intervals (3 * 60_000). The runtime
// ceiling is independent, so a tiny ceiling times a job out long before the
// first heartbeat (min interval 60_000ms) could fire.
const LEASE_MS = 3 * 60_000;
const PAST = new Date("2020-01-01T00:00:00.000Z");
const INTERVAL_SCHEDULE = {
  type: "interval",
  everyMs: 60_000,
} as const satisfies SchedulerSchedule;

let testDb: TestDatabase;
// The runner is written against the postgres-role `rootDb`; the PGlite handle
// is structurally identical for these queries (same pattern as the usage-ledger
// and entity-cap-lock DB tests).
let db: SchedulerDb;

beforeAll(async () => {
  testDb = await getTestDb();
  db = asTestRaw<SchedulerDb>(testDb);
});

afterAll(async () => {
  await releaseTestDb();
});

beforeEach(async () => {
  await testDb.delete(schedulerJobRuns);
  await testDb.delete(schedulerJobs);
});

type SeedJobOptions = {
  id?: string;
  task?: string;
  nextRunAt?: Date;
  enabled?: boolean;
  lockedBy?: string | null;
  lockedUntil?: Date | null;
};

const seedJob = async ({
  enabled = true,
  id = "test.job",
  lockedBy = null,
  lockedUntil = null,
  nextRunAt = PAST,
  task = "test.noop",
}: SeedJobOptions = {}): Promise<string> => {
  await testDb.insert(schedulerJobs).values({
    description: "test job",
    enabled,
    id,
    lockedBy,
    lockedUntil,
    nextRunAt,
    schedule: INTERVAL_SCHEDULE,
    task,
  });
  return id;
};

const readJob = async (id: string) => {
  const [job] = await testDb
    .select()
    .from(schedulerJobs)
    .where(eq(schedulerJobs.id, id));
  if (!job) {
    throw new Error(`Expected scheduler job ${id} to exist`);
  }
  return job;
};

const readLatestRun = async (jobId: string) => {
  const [run] = await testDb
    .select()
    .from(schedulerJobRuns)
    .where(eq(schedulerJobRuns.jobId, jobId))
    .orderBy(desc(schedulerJobRuns.startedAt))
    .limit(1);
  if (!run) {
    throw new Error(`Expected a run row for scheduler job ${jobId}`);
  }
  return run;
};

const registryOf = (task: string, fn: SchedulerTask): SchedulerTaskRegistry =>
  new Map([[task, fn]]);

const noopRegistry = registryOf("test.noop", () => {});

// Wraps a db handle so inserting a scheduler run row fires a side effect. Used to
// abort a parent signal exactly while runJob awaits createRun(), reproducing an
// abort that a listener attached after that await would miss.
const abortSignalWhenRunInserted = (
  base: SchedulerDb,
  onRunInsert: () => void,
): SchedulerDb =>
  new Proxy(base, {
    get(target, prop) {
      if (prop === "insert") {
        return (table: Parameters<SchedulerDb["insert"]>[0]) => {
          if (table === schedulerJobRuns) {
            onRunInsert();
          }
          return target.insert(table);
        };
      }
      // Bind delegated methods to the real handle so drizzle's query builders
      // run with `this` pointing at the underlying db, not the proxy.
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

describe("acquireDueJobs claim exclusivity", () => {
  test("two interleaved passes never claim the same job", async () => {
    await seedJob();

    const first = await acquireDueJobs({
      db,
      leaseMs: LEASE_MS,
      limit: 10,
      runnerId: "runner-a",
    });
    const second = await acquireDueJobs({
      db,
      leaseMs: LEASE_MS,
      limit: 10,
      runnerId: "runner-b",
    });

    expect(first.map((job) => job.id)).toEqual(["test.job"]);
    expect(second).toEqual([]);

    const job = await readJob("test.job");
    // lockedBy carries the per-acquisition lease token (runnerId prefix plus a
    // unique suffix), not the bare runnerId.
    expect(job.lockedBy).toMatch(/^runner-a#/u);
    expect(first.at(0)?.lockedBy).toBe(job.lockedBy);
  });
});

describe("lease expiry", () => {
  test("a job whose lease has expired is reclaimable by another runner", async () => {
    await seedJob({ lockedBy: "dead-runner", lockedUntil: PAST });

    const result = await runSchedulerOnce({
      db,
      leaseMs: LEASE_MS,
      registry: noopRegistry,
      runnerId: "fresh-runner",
    });

    expect(result).toMatchObject({ acquired: 1, succeeded: 1, failed: 0 });

    const job = await readJob("test.job");
    expect(job.lockedBy).toBeNull();
    expect(job.lastSuccessAt).not.toBeNull();
  });

  test("a job with a live lease is not reclaimed", async () => {
    const future = new Date(Date.now() + LEASE_MS);
    await seedJob({ lockedBy: "live-runner", lockedUntil: future });

    const result = await runSchedulerOnce({
      db,
      leaseMs: LEASE_MS,
      registry: noopRegistry,
      runnerId: "fresh-runner",
    });

    expect(result.acquired).toBe(0);
  });
});

describe("failure accounting", () => {
  test("a throwing task is recorded as failed and rescheduled, not wedged", async () => {
    await seedJob({ task: "test.throws" });
    const registry = registryOf("test.throws", () => {
      throw new Error("boom");
    });

    const result = await runSchedulerOnce({
      db,
      leaseMs: LEASE_MS,
      registry,
      runnerId: "runner-a",
    });

    expect(result).toMatchObject({ acquired: 1, failed: 1, succeeded: 0 });

    const job = await readJob("test.job");
    expect(job.lockedBy).toBeNull();
    expect(job.lastError).not.toBeNull();
    expect(job.lastFailureAt).not.toBeNull();
    // Rescheduled forward off the interval, so the runner is not wedged.
    expect(job.nextRunAt.getTime()).toBeGreaterThan(PAST.getTime());

    const run = await readLatestRun("test.job");
    expect(run.status).toBe("failed");
  });
});

describe("per-job runtime ceiling", () => {
  test("a task exceeding the ceiling is timed out, the runner continues, and a late zombie completion does not overwrite the timeout", async () => {
    await seedJob({ id: "hanging.job", task: "test.hangs" });
    await seedJob({ id: "healthy.job", task: "test.hangs" });

    // A task that never resolves within the ceiling; resolved manually later to
    // simulate the zombie finally completing.
    let releaseHangingTask = () => {};
    const hangingTask = new Promise<void>((resolve) => {
      releaseHangingTask = resolve;
    });
    const registry = registryOf(
      "test.hangs",
      ({ job }): Promise<void> | undefined => {
        if (job.id === "hanging.job") {
          return hangingTask;
        }
        return undefined;
      },
    );

    const result = await runSchedulerOnce({
      db,
      leaseMs: LEASE_MS,
      maxRuntimeMs: 25,
      registry,
      runnerId: "runner-a",
    });

    // One job timed out (counted as failed), the other still ran to success:
    // the hung job did not starve the rest of the pass.
    expect(result).toMatchObject({ acquired: 2, failed: 1, succeeded: 1 });

    const timedOutJob = await readJob("hanging.job");
    expect(timedOutJob.lockedBy).toBeNull();
    expect(timedOutJob.lastError).toBe("SchedulerJobTimeoutError");
    expect(timedOutJob.lastSuccessAt).toBeNull();
    expect(timedOutJob.nextRunAt.getTime()).toBeGreaterThan(PAST.getTime());

    const timedOutRun = await readLatestRun("hanging.job");
    expect(timedOutRun.status).toBe("failed");
    expect(timedOutRun.error).toBe("SchedulerJobTimeoutError");

    // The zombie task finishes late and attempts to record success. The
    // lease-token (lockedBy) and run-generation (status) guards must reject it.
    releaseHangingTask();
    await finishRunSuccess({
      db,
      job: timedOutJob,
      leaseToken: "runner-a",
      runId: timedOutRun.id,
      startedAt: timedOutRun.startedAt,
    });

    const jobAfterZombie = await readJob("hanging.job");
    expect(jobAfterZombie.lastSuccessAt).toBeNull();
    expect(jobAfterZombie.lastError).toBe("SchedulerJobTimeoutError");

    const runAfterZombie = await readLatestRun("hanging.job");
    expect(runAfterZombie.status).toBe("failed");
    expect(runAfterZombie.error).toBe("SchedulerJobTimeoutError");
  });

  test("aborts the task's signal on timeout so a cooperative task can stop", async () => {
    await seedJob({ id: "cooperative.job", task: "test.cooperative" });

    let signalAborted = false;
    // The task hangs past the ceiling; a cooperative task observes the abort on
    // its signal instead of running blind past its lease release. The promise
    // stays pending so the timeout (not a synchronous resolve) settles the race.
    const registry = registryOf("test.cooperative", async ({ signal }) => {
      signal.addEventListener("abort", () => {
        signalAborted = true;
      });
      await new Promise<void>(() => {});
    });

    const result = await runSchedulerOnce({
      db,
      leaseMs: LEASE_MS,
      maxRuntimeMs: 25,
      registry,
      runnerId: "runner-a",
    });

    expect(result).toMatchObject({ acquired: 1, failed: 1 });
    expect(signalAborted).toBe(true);

    // A ceiling expiry is still accounted as a failure, not a cooperative skip,
    // even though aborting the controller also flips `signal.aborted`.
    const run = await readLatestRun("cooperative.job");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("SchedulerJobTimeoutError");
  });

  test("a task rejecting from its own abort handler at the ceiling is still a timeout failure", async () => {
    await seedJob({ id: "abort-reject.job", task: "test.abort-reject" });

    // Emulates a resource bound to the signal (e.g. an aborted fetch): when the
    // ceiling aborts the signal, the task rejects with an AbortError that can win
    // the race ahead of our own timeout rejection.
    const registry = registryOf("test.abort-reject", async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });

    const result = await runSchedulerOnce({
      db,
      leaseMs: LEASE_MS,
      maxRuntimeMs: 25,
      registry,
      runnerId: "runner-a",
    });

    // Classified as a timeout failure (rescheduled), not a cooperative skip that
    // would leave the over-ceiling job due and retried every poll.
    expect(result).toMatchObject({ acquired: 1, failed: 1, skipped: 0 });

    const job = await readJob("abort-reject.job");
    expect(job.lastError).toBe("SchedulerJobTimeoutError");
    expect(job.lockedBy).toBeNull();
    expect(job.nextRunAt.getTime()).toBeGreaterThan(PAST.getTime());

    const run = await readLatestRun("abort-reject.job");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("SchedulerJobTimeoutError");
  });

  test("a parent abort during run creation skips the job without starting the task", async () => {
    await seedJob({ id: "abort-on-create.job", task: "test.tracked" });

    let taskRan = false;
    const registry = registryOf("test.tracked", () => {
      taskRan = true;
    });

    // Abort the parent signal at the instant the run row is inserted, i.e. while
    // runJob awaits createRun(); a listener attached after that await misses it.
    const controller = new AbortController();
    const abortingDb = abortSignalWhenRunInserted(db, () => {
      controller.abort();
    });

    const result = await runSchedulerOnce({
      db: abortingDb,
      leaseMs: LEASE_MS,
      registry,
      runnerId: "runner-a",
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      acquired: 1,
      failed: 0,
      skipped: 1,
      succeeded: 0,
    });
    // The task never started, and the lease was released cleanly.
    expect(taskRan).toBe(false);

    const job = await readJob("abort-on-create.job");
    expect(job.lockedBy).toBeNull();

    const run = await readLatestRun("abort-on-create.job");
    expect(run.status).toBe("skipped");
  });
});

// The two-layer zombie guard (run-status precondition + lease-token check) is
// funnelled through one writer, so every completion path must reject a late
// write once its run row has already reached a terminal state, even if the same
// runner has re-acquired the job under a fresh lease.
describe("zombie completion guard holds on every write path", () => {
  // Keep the run duration inside the int32 `duration_ms` column; the job's
  // nextRunAt still uses PAST (seedJob default) to prove it is left untouched.
  const RUN_STARTED_AT = new Date(Date.now() - 1000);

  const seedReacquiredJobWithTerminalRun = async () => {
    const freshLease = new Date(Date.now() + LEASE_MS);
    await seedJob({
      id: "zombie.job",
      lockedBy: "runner-a",
      lockedUntil: freshLease,
    });
    const [terminalRun] = await testDb
      .insert(schedulerJobRuns)
      .values({
        error: "SchedulerJobTimeoutError",
        finishedAt: new Date(),
        jobId: "zombie.job",
        runnerId: "runner-a",
        startedAt: RUN_STARTED_AT,
        status: "failed",
        task: "test.noop",
      })
      .returning();
    if (!terminalRun) {
      throw new Error("Expected terminal run row to be seeded");
    }
    return terminalRun;
  };

  const expectJobAndRunUntouched = async () => {
    const job = await readJob("zombie.job");
    // The re-acquired lease token survives: the zombie never cleared the lock.
    expect(job.lockedBy).toBe("runner-a");
    expect(job.nextRunAt.getTime()).toBe(PAST.getTime());
    expect(job.lastSuccessAt).toBeNull();

    const run = await readLatestRun("zombie.job");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("SchedulerJobTimeoutError");
  };

  test("finishRunSuccess", async () => {
    const terminalRun = await seedReacquiredJobWithTerminalRun();
    const job = await readJob("zombie.job");

    await finishRunSuccess({
      db,
      job,
      runId: terminalRun.id,
      leaseToken: "runner-a",
      startedAt: RUN_STARTED_AT,
    });

    await expectJobAndRunUntouched();
  });

  test("finishRunSkipped", async () => {
    const terminalRun = await seedReacquiredJobWithTerminalRun();
    const job = await readJob("zombie.job");

    await finishRunSkipped({
      db,
      job,
      runId: terminalRun.id,
      leaseToken: "runner-a",
      startedAt: RUN_STARTED_AT,
    });

    await expectJobAndRunUntouched();
  });

  test("finishRunFailure", async () => {
    const terminalRun = await seedReacquiredJobWithTerminalRun();
    const job = await readJob("zombie.job");

    await finishRunFailure({
      db,
      error: new Error("late zombie failure"),
      job,
      runId: terminalRun.id,
      leaseToken: "runner-a",
      startedAt: RUN_STARTED_AT,
    });

    await expectJobAndRunUntouched();
  });
});

// The lease token is unique per acquisition: when the same runner re-acquires a
// job while a prior execution is still running, a stale completion arriving with
// the OLD token must leave the fresh lease untouched, even though its run row is
// still `running` (so the generation check alone would let it through).
describe("stale-token completion preserves a same-runner re-acquired lease", () => {
  const RUN_STARTED_AT = new Date(Date.now() - 1000);
  const FRESH_TOKEN = "runner-a#fresh";
  const STALE_TOKEN = "runner-a#stale";

  const seedReacquiredJobWithStaleRunningRun = async () => {
    const freshLease = new Date(Date.now() + LEASE_MS);
    await seedJob({
      id: "reacquired.job",
      lockedBy: FRESH_TOKEN,
      lockedUntil: freshLease,
    });
    const [staleRun] = await testDb
      .insert(schedulerJobRuns)
      .values({
        jobId: "reacquired.job",
        runnerId: "runner-a",
        startedAt: RUN_STARTED_AT,
        status: "running",
        task: "test.noop",
      })
      .returning();
    if (!staleRun) {
      throw new Error("Expected stale running run row to be seeded");
    }
    return { freshLease, staleRun };
  };

  const expectFreshLeaseIntact = async (freshLease: Date) => {
    const job = await readJob("reacquired.job");
    expect(job.lockedBy).toBe(FRESH_TOKEN);
    expect(job.lockedUntil?.getTime()).toBe(freshLease.getTime());
    expect(job.nextRunAt.getTime()).toBe(PAST.getTime());
    expect(job.lastSuccessAt).toBeNull();
  };

  test("finishRunSuccess", async () => {
    const { freshLease, staleRun } =
      await seedReacquiredJobWithStaleRunningRun();
    const job = await readJob("reacquired.job");

    await finishRunSuccess({
      db,
      job,
      leaseToken: STALE_TOKEN,
      runId: staleRun.id,
      startedAt: RUN_STARTED_AT,
    });

    await expectFreshLeaseIntact(freshLease);
  });

  test("finishRunSkipped", async () => {
    const { freshLease, staleRun } =
      await seedReacquiredJobWithStaleRunningRun();
    const job = await readJob("reacquired.job");

    await finishRunSkipped({
      db,
      job,
      leaseToken: STALE_TOKEN,
      runId: staleRun.id,
      startedAt: RUN_STARTED_AT,
    });

    await expectFreshLeaseIntact(freshLease);
  });

  test("finishRunFailure", async () => {
    const { freshLease, staleRun } =
      await seedReacquiredJobWithStaleRunningRun();
    const job = await readJob("reacquired.job");

    await finishRunFailure({
      db,
      error: new Error("late zombie failure"),
      job,
      leaseToken: STALE_TOKEN,
      runId: staleRun.id,
      startedAt: RUN_STARTED_AT,
    });

    await expectFreshLeaseIntact(freshLease);
  });
});
