import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";

import { deferred, settledWithin } from "@stll/test-kit";
import { dbClock } from "@stll/test-kit/db";

import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { runSchedulerOnce } from "./runner";
import type { SchedulerTask } from "./types";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const LEASE_MS = 3 * 60_000;
const HEARTBEAT_INTERVAL_MS = 100;
// Far beyond any wait below, so only the heartbeat can stop the task.
const MAX_RUNTIME_MS = 60_000;
const TASK = "test.lease-handoff";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("scheduler lease handoff (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("scheduler lease handoff (postgres)", () => {
    test("a runner whose lease is taken stops its task; the new owner completes it once", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient({ max: 2 });
        const { db: secondDb } = openClient({ max: 2 });
        const jobId = `test.lease-handoff.${Bun.randomUUIDv7()}`;
        const committedBy: string[] = [];
        const firstTaskStarted = deferred();
        const firstTaskAborted = deferred();
        const releaseFirstTask = deferred();

        const firstTask: SchedulerTask = async ({ signal }) => {
          signal.addEventListener("abort", () => firstTaskAborted.resolve(), {
            once: true,
          });
          firstTaskStarted.resolve();
          await Promise.race([
            releaseFirstTask.promise,
            firstTaskAborted.promise,
          ]);
          if (signal.aborted) {
            return;
          }
          committedBy.push("runner-1");
        };
        const secondTask: SchedulerTask = () => {
          committedBy.push("runner-2");
        };

        // Settled in `finally` too, so a failed wait never deletes rows or
        // closes clients under a runner that is still writing.
        let firstRunner: ReturnType<typeof runSchedulerOnce> | undefined;

        try {
          await firstDb.insert(schedulerJobs).values({
            description: "lease handoff",
            id: jobId,
            nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
            schedule: { type: "interval", everyMs: 60_000 },
            task: TASK,
          });

          firstRunner = runSchedulerOnce({
            db: firstDb,
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            leaseMs: LEASE_MS,
            rerunLimit: 0,
            maxRuntimeMs: MAX_RUNTIME_MS,
            registry: new Map([[TASK, firstTask]]),
            runnerId: "runner-1",
          });
          await firstTaskStarted.promise;

          // Take the lease out from under runner 1: its token no longer owns the
          // row and the lease is already due for another runner to claim.
          await secondDb
            .update(schedulerJobs)
            .set({
              lockedBy: "evicted",
              lockedUntil: dbClock.ago(1000),
            })
            .where(eq(schedulerJobs.id, jobId));

          const secondResult = await runSchedulerOnce({
            db: secondDb,
            leaseMs: LEASE_MS,
            rerunLimit: 0,
            registry: new Map([[TASK, secondTask]]),
            runnerId: "runner-2",
          });
          expect(secondResult.succeeded).toBe(1);

          // Wait for the event, not for a time: the heartbeat's next renewal
          // finds the lease gone and aborts the task. The hang guard only names
          // the wait if that never happens; it does not bound runner speed.
          await settledWithin(firstTaskAborted.promise, {
            description: "runner 1 to stop its task after losing the lease",
          });
          releaseFirstTask.resolve();
          const firstResult = await firstRunner;

          expect(firstResult).toMatchObject({ acquired: 1, skipped: 1 });
          expect(committedBy).toEqual(["runner-2"]);

          const runs = await secondDb
            .select({
              error: schedulerJobRuns.error,
              runnerId: schedulerJobRuns.runnerId,
              status: schedulerJobRuns.status,
            })
            .from(schedulerJobRuns)
            .where(eq(schedulerJobRuns.jobId, jobId))
            .orderBy(asc(schedulerJobRuns.startedAt));
          expect(runs).toEqual([
            {
              error: "SchedulerLeaseLost",
              runnerId: "runner-1",
              status: "skipped",
            },
            { error: null, runnerId: "runner-2", status: "success" },
          ]);

          const [job] = await secondDb
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
          expect(job?.lockedBy).toBeNull();
          expect(job?.lastSuccessAt).toBeInstanceOf(Date);
        } finally {
          releaseFirstTask.resolve();
          await Promise.allSettled([firstRunner]);
          await secondDb
            .delete(schedulerJobRuns)
            .where(eq(schedulerJobRuns.jobId, jobId));
          await secondDb
            .delete(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
        }
      });
    });
  });
}
