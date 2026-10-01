import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

import { DECLARED_SCHEDULER_JOBS, ensureSchedulerJob } from "./jobs";
import { acquireNextDueJob, runJob } from "./runner";
import type { SchedulerTask } from "./types";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const LEASE_MS = 3 * 60_000;
const CLOCK_MS = Date.parse("2040-01-01T00:00:00.000Z");
const PAUSED_BY = "test-operator";
const PAUSE_REASON = "Scheduler maintenance";

type Fixture = { db: GatedTestDb; jobId: string; taskName: string };

const withJob = async (exercise: (fixture: Fixture) => Promise<void>) => {
  if (!databaseUrl) {
    return panic("Scheduler pause tests require DATABASE_URL");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db } = openClient();
    const jobId = `test.pause.${Bun.randomUUIDv7()}`;
    const taskName = `${jobId}.task`;
    const definition = DECLARED_SCHEDULER_JOBS.at(0);
    if (!definition) {
      return panic("Scheduler declarations must not be empty");
    }
    try {
      await ensureSchedulerJob({
        ...definition,
        db,
        enabled: undefined,
        id: jobId,
      });
      const [created] = await db
        .select()
        .from(schedulerJobs)
        .where(eq(schedulerJobs.id, jobId));
      expect(created?.enabled).toBe(true);
      await db
        .update(schedulerJobs)
        .set({
          nextRunAt: new Date(CLOCK_MS - 60_000),
          task: taskName,
        })
        .where(eq(schedulerJobs.id, jobId));
      await exercise({ db, jobId, taskName });
    } finally {
      await db.delete(schedulerJobs).where(eq(schedulerJobs.id, jobId));
    }
  });
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("scheduler operator pauses (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("scheduler operator pauses (postgres)", () => {
    test("the suite uses PostgreSQL 18", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { sql: client } = openClient();
        const [server] = await client<
          { version: number }[]
        >`SELECT current_setting('server_version_num')::integer AS version`;
        expect(server?.version).toBeGreaterThanOrEqual(180_000);
        expect(server?.version).toBeLessThan(190_000);
      });
    });

    test("every declared job preserves operator state across a boot while new jobs start enabled", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const prefix = `pause.${Bun.randomUUIDv7()}.`;
        const definitions = DECLARED_SCHEDULER_JOBS.map((definition) =>
          ({ ...definition, db,
            enabled: "enabled" in definition ? definition.enabled : true,
            id: `${prefix}${definition.id}`,}),
        );
        const ids = definitions.map(({ id }) => id);
        expect(ids.length).toBeGreaterThan(0);
        try {
          for (const definition of definitions) {
            await ensureSchedulerJob(definition);
          }
          const inserted = await db
            .select()
            .from(schedulerJobs)
            .where(inArray(schedulerJobs.id, ids));
          expect(inserted.length).toBe(ids.length);
          for (const definition of definitions) {
            expect(
              inserted.find((job) => job.id === definition.id),
            ).toMatchObject({
              enabled: definition.enabled,
              pausedUntil: null,
            });
          }

          const pausedUntil = new Date(CLOCK_MS + 60_000);
          await db
            .update(schedulerJobs)
            .set({
              pausedBy: PAUSED_BY,
              pausedUntil,
              pauseReason: PAUSE_REASON,
            })
            .where(inArray(schedulerJobs.id, ids));
          const disabledId = ids.at(0);
          if (!disabledId) {
            return panic("Scheduler declarations must not be empty");
          }
          await db
            .update(schedulerJobs)
            .set({ enabled: false })
            .where(eq(schedulerJobs.id, disabledId));
          for (const definition of definitions) {
            await ensureSchedulerJob({ ...definition, enabled: true });
          }
          const rebooted = await db
            .select()
            .from(schedulerJobs)
            .where(inArray(schedulerJobs.id, ids));
          expect(rebooted.length).toBe(ids.length);
          for (const definition of definitions) {
            expect(
              rebooted.find((job) => job.id === definition.id),
            ).toMatchObject({
              enabled:
                definition.id === disabledId ? false : definition.enabled,
              pausedBy: PAUSED_BY,
              pausedUntil,
              pauseReason: PAUSE_REASON,
            });
          }
        } finally {
          await db.delete(schedulerJobs).where(inArray(schedulerJobs.id, ids));
        }
      });
    });

    test("disabled jobs cannot be claimed even after their pause expires", async () => {
      await withJob(async ({ db, jobId, taskName }) => {
        await db
          .update(schedulerJobs)
          .set({ enabled: false, pausedUntil: new Date(CLOCK_MS - 1) })
          .where(eq(schedulerJobs.id, jobId));
        const task: SchedulerTask = () => panic("Disabled job must not run");
        const job = await acquireNextDueJob({
          db,
          leaseMs: LEASE_MS,
          now: () => CLOCK_MS,
          registry: new Map([[taskName, task]]),
          runnerId: jobId,
        });
        expect(job).toBeNull();
      });
    });

    test("a past pause is cleared and the task completes normally", async () => {
      await withJob(async ({ db, jobId, taskName }) => {
        await db
          .update(schedulerJobs)
          .set({
            pausedBy: PAUSED_BY,
            pausedUntil: new Date(CLOCK_MS - 1),
            pauseReason: PAUSE_REASON,
          })
          .where(eq(schedulerJobs.id, jobId));
        const completed: string[] = [];
        const task: SchedulerTask = ({ job }) => {
          completed.push(job.id);
        };
        const registry = new Map([[taskName, task]]);
        const job = await acquireNextDueJob({
          db,
          leaseMs: LEASE_MS,
          now: () => CLOCK_MS,
          registry,
          runnerId: jobId,
        });
        if (!job) {
          return panic("Expired pause must permit acquisition");
        }
        expect(job).toMatchObject({
          id: jobId,
          pausedUntil: null,
          pausedBy: PAUSED_BY,
          pauseReason: PAUSE_REASON,
        });
        expect(
          await runJob({
            db,
            heartbeatIntervalMs: 1000,
            job,
            leaseMs: LEASE_MS,
            maxRuntimeMs: 60_000,
            now: () => CLOCK_MS,
            registry,
            runnerId: jobId,
            signal: undefined,
          }),
        ).toBe("success");
        expect(completed).toEqual([jobId]);
        const runs = await db
          .select()
          .from(schedulerJobRuns)
          .where(eq(schedulerJobRuns.jobId, jobId));
        expect(runs).toHaveLength(1);
        expect(runs.at(0)?.status).toBe("success");
      });
    });

    test("a future pause prevents acquisition until the injected clock reaches its exact deadline", async () => {
      await withJob(async ({ db, jobId, taskName }) => {
        let clockMs = CLOCK_MS;
        await db
          .update(schedulerJobs)
          .set({
            pausedBy: PAUSED_BY,
            pausedUntil: new Date(CLOCK_MS + 1),
            pauseReason: PAUSE_REASON,
          })
          .where(eq(schedulerJobs.id, jobId));
        const task: SchedulerTask = () => {};
        const options = {
          db,
          leaseMs: LEASE_MS,
          now: () => clockMs,
          registry: new Map([[taskName, task]]),
          runnerId: jobId,
        };
        expect(await acquireNextDueJob(options)).toBeNull();
        const [paused] = await db
          .select()
          .from(schedulerJobs)
          .where(eq(schedulerJobs.id, jobId));
        expect(paused?.pausedUntil).toEqual(new Date(CLOCK_MS + 1));
        expect(paused?.lockedBy).toBeNull();
        clockMs += 1;
        const resumed = await acquireNextDueJob(options);
        expect(resumed).toMatchObject({
          id: jobId,
          pausedUntil: null,
          pausedBy: PAUSED_BY,
          pauseReason: PAUSE_REASON,
        });
        expect(resumed?.lockedBy).toBeString();
        await db
          .update(schedulerJobs)
          .set({
            lockedBy: null,
            lockedUntil: null,
            pausedUntil: sql`'infinity'::timestamptz`,
          })
          .where(eq(schedulerJobs.id, jobId));
        clockMs += 365 * 24 * 60 * 60_000;
        expect(await acquireNextDueJob(options)).toBeNull();
        const [indefinite] = await db
          .select({
            paused: sql<boolean>`${schedulerJobs.pausedUntil} = 'infinity'::timestamptz`,
          })
          .from(schedulerJobs)
          .where(eq(schedulerJobs.id, jobId));
        expect(indefinite?.paused).toBe(true);
      });
    });

    test("a pause committed after acquisition blocks the handler and records an error with attribution", async () => {
      await withJob(async ({ db, jobId, taskName }) => {
        const invoked: string[] = [];
        const task: SchedulerTask = ({ job }) => {
          invoked.push(job.id);
        };
        const registry = new Map([[taskName, task]]);
        const job = await acquireNextDueJob({
          db,
          leaseMs: LEASE_MS,
          now: () => CLOCK_MS,
          registry,
          runnerId: jobId,
        });
        if (!job) {
          return panic("Unpaused job must permit acquisition");
        }
        expect(job.pausedUntil).toBeNull();
        await db
          .update(schedulerJobs)
          .set({
            pausedBy: PAUSED_BY,
            pausedUntil: new Date(CLOCK_MS + 60_000),
            pauseReason: PAUSE_REASON,
          })
          .where(eq(schedulerJobs.id, jobId));
        const logs = installRecordingLogger();
        try {
          expect(
            await runJob({
              db,
              heartbeatIntervalMs: 1000,
              job,
              leaseMs: LEASE_MS,
              maxRuntimeMs: 60_000,
              now: () => CLOCK_MS,
              registry,
              runnerId: jobId,
              signal: undefined,
            }),
          ).toBe("skipped");
          expect(invoked).toEqual([]);
          expect(logs.at("ERROR")).toContainEqual(
            expect.objectContaining({
              message: "scheduler.job.paused_job_ran",
              attributes: expect.objectContaining({
                jobId,
                pausedBy: PAUSED_BY,
                pauseReason: PAUSE_REASON,
              }),
            }),
          );
          const [persisted] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
          expect(persisted?.pausedUntil).toEqual(new Date(CLOCK_MS + 60_000));
          expect(persisted?.lockedBy).toBeNull();
          const runs = await db
            .select()
            .from(schedulerJobRuns)
            .where(eq(schedulerJobRuns.jobId, jobId));
          expect(runs).toHaveLength(1);
          expect(runs.at(0)).toMatchObject({
            status: "skipped",
            error: "SchedulerOperatorPaused",
          });
        } finally {
          logs.restore();
        }
      });
    });

    test("a handler completing before its heartbeat records a concurrent pause without replaying completed work", async () => {
      await withJob(async ({ db, jobId, taskName }) => {
        const completed: string[] = [];
        const task: SchedulerTask = async () => {
          await db
            .update(schedulerJobs)
            .set({
              pausedBy: PAUSED_BY,
              pausedUntil: new Date(CLOCK_MS + 60_000),
              pauseReason: PAUSE_REASON,
            })
            .where(eq(schedulerJobs.id, jobId));
          completed.push(jobId);
        };
        const registry = new Map([[taskName, task]]);
        const job = await acquireNextDueJob({
          db,
          leaseMs: LEASE_MS,
          now: () => CLOCK_MS,
          registry,
          runnerId: jobId,
        });
        if (!job) {
          return panic("Unpaused job must permit acquisition");
        }
        const logs = installRecordingLogger();
        try {
          expect(
            await runJob({
              db,
              heartbeatIntervalMs: 60_000,
              job,
              leaseMs: LEASE_MS,
              maxRuntimeMs: 2000,
              now: () => CLOCK_MS,
              registry,
              runnerId: jobId,
              signal: undefined,
            }),
          ).toBe("success");
          expect(completed).toEqual([jobId]);
          expect(logs.at("ERROR")).toContainEqual(
            expect.objectContaining({
              message: "scheduler.job.paused_job_ran",
              attributes: expect.objectContaining({
                jobId,
                pausedBy: PAUSED_BY,
                pauseReason: PAUSE_REASON,
              }),
            }),
          );
          const [persisted] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
          expect(persisted?.pausedUntil).toEqual(new Date(CLOCK_MS + 60_000));
          expect(persisted?.lockedBy).toBeNull();
          expect(
            await acquireNextDueJob({
              db,
              leaseMs: LEASE_MS,
              now: () => CLOCK_MS,
              registry,
              runnerId: jobId,
            }),
          ).toBeNull();
          const runs = await db
            .select()
            .from(schedulerJobRuns)
            .where(eq(schedulerJobRuns.jobId, jobId));
          expect(runs).toHaveLength(1);
          expect(runs.at(0)).toMatchObject({ status: "success", error: null });
          expect(completed).toEqual([jobId]);
        } finally {
          logs.restore();
        }
      });
    });

    test("a pause during execution aborts a cooperative handler at its next checkpoint", async () => {
      await withJob(async ({ db, jobId, taskName }) => {
        const checkpoints: string[] = [];
        const task: SchedulerTask = async ({ signal }) => {
          const aborted = new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          await db
            .update(schedulerJobs)
            .set({
              pausedBy: PAUSED_BY,
              pausedUntil: new Date(CLOCK_MS + 60_000),
              pauseReason: PAUSE_REASON,
            })
            .where(eq(schedulerJobs.id, jobId));
          checkpoints.push("pause committed");
          await aborted;
          expect(signal.aborted).toBe(true);
          checkpoints.push("aborted");
        };
        const registry = new Map([[taskName, task]]);
        const job = await acquireNextDueJob({
          db,
          leaseMs: LEASE_MS,
          now: () => CLOCK_MS,
          registry,
          runnerId: jobId,
        });
        if (!job) {
          return panic("Unpaused job must permit acquisition");
        }
        const logs = installRecordingLogger();
        try {
          expect(
            await runJob({
              db,
              heartbeatIntervalMs: 20,
              job,
              leaseMs: LEASE_MS,
              maxRuntimeMs: 2000,
              now: () => CLOCK_MS,
              registry,
              runnerId: jobId,
              signal: undefined,
            }),
          ).toBe("skipped");
          expect(checkpoints).toEqual(["pause committed", "aborted"]);
          expect(logs.at("ERROR")).toContainEqual(
            expect.objectContaining({
              message: "scheduler.job.paused_job_ran",
              attributes: expect.objectContaining({
                jobId,
                pausedBy: PAUSED_BY,
                pauseReason: PAUSE_REASON,
              }),
            }),
          );
          const [persisted] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
          expect(persisted?.pausedUntil).toEqual(new Date(CLOCK_MS + 60_000));
          expect(persisted?.lockedBy).toBeNull();
          const runs = await db
            .select()
            .from(schedulerJobRuns)
            .where(eq(schedulerJobRuns.jobId, jobId));
          expect(runs).toHaveLength(1);
          expect(runs.at(0)?.status).toBe("skipped");
        } finally {
          logs.restore();
        }
      });
    });
  });
}
