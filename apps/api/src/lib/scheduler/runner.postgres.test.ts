import { describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";

import { deferred, settledWithin } from "@stll/test-kit";
import { dbClock } from "@stll/test-kit/db";

import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import {
  writePlatformSchedulerTaskState,
  writeSchedulerJobOperatorPause,
  writeSearchSemanticTimestampsState,
} from "@/api/lib/scheduler/upsert-job";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { runSchedulerOnce } from "./runner";
import { REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK } from "./tasks/search-semantic-timestamps";
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
    test("a platform checkpoint matches both its canonical task and exact lease", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const suffix = Bun.randomUUIDv7();
        const jobId = `test.platform-checkpoint.${suffix}`;
        const otherJobId = `test.platform-checkpoint-other.${suffix}`;
        const leaseToken = `lease.${suffix}`;
        const otherPayload = { cursor: "untouched" };

        try {
          await db.insert(schedulerJobs).values([
            {
              description: "platform checkpoint",
              id: jobId,
              lockedBy: leaseToken,
              nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
              payload: null,
              schedule: { type: "interval", everyMs: 60_000 },
              task: "workObligations.attentionScout",
            },
            {
              description: "different task",
              id: otherJobId,
              lockedBy: leaseToken,
              nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
              payload: otherPayload,
              schedule: { type: "interval", everyMs: 60_000 },
              task: "workObligations.backfillLegacyTasks",
            },
          ]);

          await writePlatformSchedulerTaskState({
            db,
            jobId,
            leaseToken,
            state: { type: "checkpoint", payload: { cursor: "advanced" } },
            task: "workObligations.attentionScout",
          });
          await writePlatformSchedulerTaskState({
            db,
            jobId: otherJobId,
            leaseToken,
            state: {
              type: "checkpoint",
              payload: { cursor: "must-not-write" },
            },
            task: "workObligations.attentionScout",
          });
          await writePlatformSchedulerTaskState({
            db,
            jobId,
            leaseToken: "stale-lease",
            state: { type: "retire" },
            task: "workObligations.attentionScout",
          });

          const rows = await db
            .select({
              enabled: schedulerJobs.enabled,
              id: schedulerJobs.id,
              payload: schedulerJobs.payload,
            })
            .from(schedulerJobs)
            .where(inArray(schedulerJobs.id, [jobId, otherJobId]));
          const rowsById = Object.fromEntries(
            rows.map(({ enabled, id, payload }) => [id, { enabled, payload }]),
          );
          expect(rowsById).toEqual({
            [jobId]: { enabled: true, payload: { cursor: "advanced" } },
            [otherJobId]: { enabled: true, payload: otherPayload },
          });
        } finally {
          await db
            .delete(schedulerJobs)
            .where(inArray(schedulerJobs.id, [jobId, otherJobId]));
        }
      });
    });

    test("semantic timestamp states require the canonical task and lease", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const suffix = Bun.randomUUIDv7();
        const jobId = `test.search-semantic.${suffix}`;
        const otherTaskJobId = `test.search-semantic-other.${suffix}`;
        const leaseToken = `lease.${suffix}`;
        const schedule = { type: "interval", everyMs: 60_000 } as const;

        try {
          await db.insert(schedulerJobs).values([
            {
              description: "semantic timestamp checkpoint",
              id: jobId,
              lockedBy: leaseToken,
              nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
              payload: null,
              schedule,
              task: REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK,
            },
            {
              description: "wrong task",
              id: otherTaskJobId,
              lockedBy: leaseToken,
              nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
              payload: { marker: "unchanged" },
              schedule,
              task: "test.not-semantic-timestamps",
            },
          ]);

          const expectedPayloads = [
            {
              state: {
                type: "restart-verification",
                cleanPasses: 0,
                passStartedAt: "2026-10-30T10:00:00.000Z",
                quietSince: "2026-10-30T09:45:00.000Z",
              },
              payload: {
                pass: "verify",
                dirty: false,
                cleanPasses: 0,
                passStartedAt: "2026-10-30T10:00:00.000Z",
                quietSince: "2026-10-30T09:45:00.000Z",
              },
            },
            {
              state: {
                type: "dirty-verification",
                cursor: null,
                passStartedAt: null,
                quietSince: "2026-10-30T10:01:00.000Z",
              },
              payload: {
                cursor: null,
                pass: "verify",
                dirty: true,
                cleanPasses: 0,
                passStartedAt: null,
                quietSince: "2026-10-30T10:01:00.000Z",
              },
            },
            {
              state: {
                type: "checkpoint-verification",
                cursor: "11111111-1111-4111-8111-111111111111",
                dirty: false,
                cleanPasses: 1,
                passStartedAt: null,
                quietSince: "2026-10-30T10:01:00.000Z",
              },
              payload: {
                cursor: "11111111-1111-4111-8111-111111111111",
                pass: "verify",
                dirty: false,
                cleanPasses: 1,
                passStartedAt: null,
                quietSince: "2026-10-30T10:01:00.000Z",
              },
            },
            {
              state: {
                type: "checkpoint-repair",
                cursor: "22222222-2222-4222-8222-222222222222",
              },
              payload: {
                cursor: "22222222-2222-4222-8222-222222222222",
                pass: "repair",
              },
            },
          ] as const;

          for (const { state, payload } of expectedPayloads) {
            await writeSearchSemanticTimestampsState({
              db,
              jobId,
              leaseToken,
              state,
            });
            const [row] = await db
              .select({ payload: schedulerJobs.payload })
              .from(schedulerJobs)
              .where(eq(schedulerJobs.id, jobId));
            expect(row?.payload).toEqual(payload);
          }

          await writeSearchSemanticTimestampsState({
            db,
            jobId,
            leaseToken: "stale-lease",
            state: { type: "complete" },
          });
          await writeSearchSemanticTimestampsState({
            db,
            jobId: otherTaskJobId,
            leaseToken,
            state: { type: "complete" },
          });
          const unchangedRows = await db
            .select({
              enabled: schedulerJobs.enabled,
              id: schedulerJobs.id,
              payload: schedulerJobs.payload,
            })
            .from(schedulerJobs)
            .where(inArray(schedulerJobs.id, [jobId, otherTaskJobId]));
          const rowsById = Object.fromEntries(
            unchangedRows.map(({ enabled, id, payload }) => [
              id,
              { enabled, payload },
            ]),
          );
          expect(rowsById).toEqual({
            [jobId]: {
              enabled: true,
              payload: expectedPayloads.at(-1)?.payload,
            },
            [otherTaskJobId]: {
              enabled: true,
              payload: { marker: "unchanged" },
            },
          });

          await writeSearchSemanticTimestampsState({
            db,
            jobId,
            leaseToken,
            state: { type: "complete" },
          });
          const [completed] = await db
            .select({
              enabled: schedulerJobs.enabled,
              payload: schedulerJobs.payload,
            })
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
          expect(completed).toEqual({
            enabled: false,
            payload: expectedPayloads.at(-1)?.payload,
          });
        } finally {
          await db
            .delete(schedulerJobs)
            .where(inArray(schedulerJobs.id, [jobId, otherTaskJobId]));
        }
      });
    });

    test("operator pause and resume preserve pause timestamps and return the row", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const suffix = Bun.randomUUIDv7();
        const jobId = `test.operator-pause.${suffix}`;
        const schedule = { type: "interval", everyMs: 60_000 } as const;

        try {
          await db.insert(schedulerJobs).values({
            description: "operator pause",
            id: jobId,
            nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
            schedule,
            task: "test.operator-pause",
          });

          const [firstPause] = await writeSchedulerJobOperatorPause({
            db,
            jobId,
            state: {
              type: "pause",
              actor: "test-operator",
              reason: "Pause for measured regression",
              durationMinutes: 60,
            },
          });
          expect(firstPause?.pausedBy).toBe("test-operator");
          expect(firstPause?.pauseReason).toBe("Pause for measured regression");
          expect(firstPause?.pausedSince).toBeInstanceOf(Date);
          expect(firstPause?.pausedUntil).toBeInstanceOf(Date);
          expect(firstPause?.enabled).toBe(true);

          const [renewedPause] = await writeSchedulerJobOperatorPause({
            db,
            jobId,
            state: {
              type: "pause",
              actor: "renewing-operator",
              reason: "Renew measured regression pause",
              durationMinutes: 120,
            },
          });
          expect(renewedPause?.pausedBy).toBe("renewing-operator");
          expect(renewedPause?.pauseReason).toBe(
            "Renew measured regression pause",
          );
          expect(renewedPause?.pausedSince).toEqual(firstPause?.pausedSince);
          expect(renewedPause?.pausedUntil?.getTime()).toBeGreaterThan(
            firstPause?.pausedUntil?.getTime() ?? Number.POSITIVE_INFINITY,
          );

          const [resumed] = await writeSchedulerJobOperatorPause({
            db,
            jobId,
            state: {
              type: "resume",
              actor: "test-operator",
              reason: "Resume measured regression job",
            },
          });
          expect(resumed).toEqual({
            enabled: true,
            id: jobId,
            pauseReason: "Resume measured regression job",
            pausedBy: "test-operator",
            pausedSince: null,
            pausedUntil: null,
          });
        } finally {
          await db.delete(schedulerJobs).where(eq(schedulerJobs.id, jobId));
        }
      });
    });

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

          // Wait for the event, not for a time: the heartbeat's next renewal
          // finds the lease gone and aborts the task. The hang guard only names
          // the wait if that never happens; it does not bound runner speed.
          await settledWithin(firstTaskAborted.promise, {
            description: "runner 1 to stop its task after losing the lease",
          });
          releaseFirstTask.resolve();
          // A renewal already waiting behind the eviction can briefly retain
          // the row lock after its token check fails. Drain runner 1 before
          // runner 2 claims with SKIP LOCKED, which may otherwise skip that row.
          const firstResult = await firstRunner;

          const secondResult = await runSchedulerOnce({
            db: secondDb,
            leaseMs: LEASE_MS,
            rerunLimit: 0,
            registry: new Map([[TASK, secondTask]]),
            runnerId: "runner-2",
          });
          expect(secondResult.succeeded).toBe(1);

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
