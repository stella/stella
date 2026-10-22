import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

import { DECLARED_SCHEDULER_JOBS, upsertSchedulerJob } from "./jobs";
import { acquireNextDueJob, runJob } from "./runner";
import { createCaseLawProvisionStateBackfillTask } from "./tasks/case-law-provision-state-backfill";
import { createLegislationExpressionIdBackfill } from "./tasks/legislation-expression-id-backfill";
import type { SchedulerTask } from "./types";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const LEASE_MS = 3 * 60_000;
const CLOCK_MS = Date.now() + 60 * 60_000;
const PAUSED_BY = "test-operator";
const PAUSE_REASON = "Scheduler maintenance";

type Fixture = {
  db: GatedTestDb;
  client: SQL;
  jobId: string;
  taskName: string;
};

const withJob = async (exercise: (fixture: Fixture) => Promise<void>) => {
  const url =
    databaseUrl ?? panic("Scheduler pause tests require DATABASE_URL");
  await withGatedTestClients(url, async ({ openClient }) => {
    const { db, sql: client } = openClient();
    const jobId = `test.pause.${Bun.randomUUIDv7()}`;
    const taskName = `${jobId}.task`;
    const definition =
      DECLARED_SCHEDULER_JOBS.at(0) ??
      panic("Scheduler declarations must not be empty");
    try {
      await upsertSchedulerJob(
        {
          description: definition.description,
          id: jobId,
          schedule: definition.schedule,
          task: definition.task,
        },
        db,
      );
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
      await exercise({ db, client, jobId, taskName });
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
    test("the database bounds pauses and preserves their original start", async () => {
      await withJob(async ({ client, db, jobId }) => {
        const rejectedInfinity = await client`UPDATE scheduler_jobs
          SET paused_until = 'infinity'::timestamptz, paused_by = ${PAUSED_BY}, pause_reason = ${PAUSE_REASON}
          WHERE id = ${jobId}`
          .execute()
          .then(
            () => "accepted",
            (error: unknown) =>
              error instanceof Error ? error.message : String(error),
          );
        expect(rejectedInfinity).not.toBe("accepted");

        const rejectedLongPause = await client`UPDATE scheduler_jobs
          SET paused_until = now() + interval '72 hours 1 minute', paused_by = ${PAUSED_BY}, pause_reason = ${PAUSE_REASON}
          WHERE id = ${jobId}`
          .execute()
          .then(
            () => "accepted",
            (error: unknown) =>
              error instanceof Error ? error.message : String(error),
          );
        expect(rejectedLongPause).toContain("72-hour maximum");

        await client`UPDATE scheduler_jobs
          SET paused_until = now() + interval '71 hours 59 minutes', paused_by = ${PAUSED_BY}, pause_reason = ${PAUSE_REASON}
          WHERE id = ${jobId}`;
        const [initial] = await db
          .select()
          .from(schedulerJobs)
          .where(eq(schedulerJobs.id, jobId));
        expect(initial?.pausedSince).toBeInstanceOf(Date);

        await client`UPDATE scheduler_jobs
          SET paused_until = now() + interval '71 hours 58 minutes'
          WHERE id = ${jobId}`;
        const [renewed] = await db
          .select()
          .from(schedulerJobs)
          .where(eq(schedulerJobs.id, jobId));
        expect(renewed?.pausedSince).toEqual(initial?.pausedSince);

        await db
          .update(schedulerJobs)
          .set({ pausedUntil: null })
          .where(eq(schedulerJobs.id, jobId));
        const [resumed] = await db
          .select()
          .from(schedulerJobs)
          .where(eq(schedulerJobs.id, jobId));
        expect(resumed?.pausedSince).toBeNull();
      });
    });

    test("the pause trigger initializes paused_since on insert", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db, sql: client } = openClient();
        const jobId = `test.pause.insert.${Bun.randomUUIDv7()}`;
        try {
          await client`INSERT INTO scheduler_jobs
            (id, task, schedule, enabled, paused_by, pause_reason, paused_until, next_run_at)
            VALUES (${jobId}, 'scheduler.noop', ${JSON.stringify({ type: "interval", everyMs: 60_000 })}::text::jsonb, true,
              ${PAUSED_BY}, ${PAUSE_REASON}, now() + interval '1 hour', now())`;
          const [inserted] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
          expect(inserted?.pausedSince).toBeInstanceOf(Date);
        } finally {
          await db.delete(schedulerJobs).where(eq(schedulerJobs.id, jobId));
        }
      });
    });

    test("the pause audit job can never be paused, by insert or update", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { sql: client } = openClient();
        // An upsert reaches the check on both paths: a fresh row is inserted
        // paused, an existing (declared) row is updated to paused.
        const pausedAudit = await client`INSERT INTO scheduler_jobs
          (id, task, schedule, enabled, paused_by, pause_reason, paused_until, next_run_at)
          VALUES ('scheduler.pauseAudit.hourly', 'scheduler.auditPauses',
            ${JSON.stringify({ type: "interval", everyMs: 3_600_000 })}::text::jsonb, true,
            ${PAUSED_BY}, ${PAUSE_REASON}, now() + interval '1 hour', now())
          ON CONFLICT (id) DO UPDATE SET paused_until = EXCLUDED.paused_until,
            paused_by = EXCLUDED.paused_by, pause_reason = EXCLUDED.pause_reason`
          .execute()
          .then(
            () => "accepted",
            (error: unknown) =>
              error instanceof Error ? error.message : String(error),
          );
        expect(pausedAudit).toContain(
          "scheduler_jobs_pause_audit_unpausable_check",
        );
      });
    });

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

    test("every declared job follows configuration gates across boots while preserving operator pauses", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const prefix = `pause.${Bun.randomUUIDv7()}.`;
        const definitions = [];
        for (const definition of DECLARED_SCHEDULER_JOBS) {
          definitions.push({
            ...definition,
            enabled: "enabled" in definition ? definition.enabled : true,
            id: `${prefix}${definition.id}`,
          });
        }
        const ids = definitions.map(({ id }) => id);
        expect(ids.length).toBeGreaterThan(0);
        try {
          for (const definition of definitions) {
            await upsertSchedulerJob(definition, db);
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
          for (const enabled of [false, true, false]) {
            for (const definition of definitions) {
              await upsertSchedulerJob({ ...definition, enabled }, db);
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
                enabled,
                pausedBy: PAUSED_BY,
                pausedUntil,
                pauseReason: PAUSE_REASON,
              });
            }
          }
        } finally {
          await db.delete(schedulerJobs).where(inArray(schedulerJobs.id, ids));
        }
      });
    });

    test("pause deadlines require nonblank attribution and a reason of at least eight trimmed characters", async () => {
      await withJob(async ({ db, client, jobId }) => {
        for (const pausedUntil of [
          new Date(CLOCK_MS - 1),
          new Date(CLOCK_MS + 60_000),
        ]) {
          for (const attribution of [
            { pausedBy: null, pauseReason: PAUSE_REASON },
            { pausedBy: "", pauseReason: PAUSE_REASON },
            { pausedBy: "   ", pauseReason: PAUSE_REASON },
            { pausedBy: PAUSED_BY, pauseReason: null },
            { pausedBy: PAUSED_BY, pauseReason: "" },
            { pausedBy: PAUSED_BY, pauseReason: "   " },
            { pausedBy: PAUSED_BY, pauseReason: " 1234567 " },
          ]) {
            // bun-types declares `.rejects.toThrow` as void, so awaiting it
            // trips type-aware lint; capture the refusal explicitly instead.
            const refusal = await client`UPDATE scheduler_jobs
              SET paused_until = ${pausedUntil}, paused_by = ${attribution.pausedBy}, pause_reason = ${attribution.pauseReason}
              WHERE id = ${jobId}`
              .execute()
              .then(
                () => "accepted",
                (error: unknown) =>
                  error instanceof Error ? error.message : String(error),
              );
            expect(refusal).toContain("scheduler_jobs_pause_attribution_check");
          }
          await db
            .update(schedulerJobs)
            .set({
              pausedUntil,
              pausedBy: " operator ",
              pauseReason: " 12345678 ",
            })
            .where(eq(schedulerJobs.id, jobId));
          const [paused] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
          expect(paused?.pausedUntil).toEqual(pausedUntil);
        }
        await db
          .update(schedulerJobs)
          .set({ pausedUntil: null, pausedBy: null, pauseReason: null })
          .where(eq(schedulerJobs.id, jobId));
        const [resumed] = await db
          .select()
          .from(schedulerJobs)
          .where(eq(schedulerJobs.id, jobId));
        expect(resumed).toMatchObject({
          pausedUntil: null,
          pausedBy: null,
          pauseReason: null,
        });
      });
    });

    test("a configuration gate disabled after acquisition records a disabled skip without a pause event", async () => {
      await withJob(async ({ db, jobId, taskName }) => {
        const invoked: string[] = [];
        const task: SchedulerTask = ({ job }) => {
          invoked.push(job.id);
        };
        const registry = new Map([[taskName, task]]);
        const job =
          (await acquireNextDueJob({
            db,
            leaseMs: LEASE_MS,
            now: () => CLOCK_MS,
            registry,
            runnerId: jobId,
          })) ?? panic("Enabled job must permit acquisition");
        await db
          .update(schedulerJobs)
          .set({ enabled: false })
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
          expect(
            logs
              .at("ERROR")
              .filter(
                ({ message }) => message === "scheduler.job.paused_job_ran",
              ),
          ).toEqual([]);
          const runs = await db
            .select()
            .from(schedulerJobRuns)
            .where(eq(schedulerJobRuns.jobId, jobId));
          expect(runs).toHaveLength(1);
          expect(runs.at(0)).toMatchObject({
            status: "skipped",
            error: "SchedulerJobDisabled",
          });
          const [persisted] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
          expect(persisted?.lockedBy).toBeNull();
        } finally {
          logs.restore();
        }
      });
    });

    test("disabled jobs cannot be claimed even after their pause expires", async () => {
      await withJob(async ({ db, jobId, taskName }) => {
        await db
          .update(schedulerJobs)
          .set({
            enabled: false,
            pausedUntil: new Date(CLOCK_MS - 1),
            pausedBy: PAUSED_BY,
            pauseReason: PAUSE_REASON,
          })
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
        const job =
          (await acquireNextDueJob({
            db,
            leaseMs: LEASE_MS,
            now: () => CLOCK_MS,
            registry,
            runnerId: jobId,
          })) ?? panic("Expired pause must permit acquisition");
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
        const [cleared] = await db
          .select({ pausedSince: schedulerJobs.pausedSince })
          .from(schedulerJobs)
          .where(eq(schedulerJobs.id, jobId));
        expect(cleared?.pausedSince).toBeNull();
      });
    });

    test.each(["provision-state", "expression-ids"] as const)(
      "%s operator pause prevents runtime initialization despite a healthy signal",
      async (kind) => {
        await withJob(async ({ db, jobId, taskName }) => {
          let readings = 0;
          const readVerdict = async () => {
            readings += 1;
            return { kind: "normal" as const, signals: [] };
          };
          const task =
            kind === "provision-state"
              ? createCaseLawProvisionStateBackfillTask({ readVerdict })
              : createLegislationExpressionIdBackfill({ readVerdict });
          const registry = new Map([[taskName, task]]);
          const job =
            (await acquireNextDueJob({
              db,
              leaseMs: LEASE_MS,
              now: () => CLOCK_MS,
              registry,
              runnerId: jobId,
            })) ?? panic("Expected scheduler lease");
          const pausedUntil = new Date(CLOCK_MS + 60_000);
          await db
            .update(schedulerJobs)
            .set({
              pausedUntil,
              pausedBy: PAUSED_BY,
              pauseReason: PAUSE_REASON,
            })
            .where(eq(schedulerJobs.id, jobId));
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
          expect(readings).toBe(0);
          const persisted = (
            await db
              .select()
              .from(schedulerJobs)
              .where(eq(schedulerJobs.id, jobId))
          ).at(0);
          expect(persisted).toMatchObject({
            pausedUntil,
            pausedBy: PAUSED_BY,
            pauseReason: PAUSE_REASON,
          });
        });
      },
    );

    test.each([true, false])(
      "a pause committed after acquisition blocks the handler and records attribution (enabled=%s)",
      async (enabled) => {
        await withJob(async ({ db, jobId, taskName }) => {
          const invoked: string[] = [];
          const task: SchedulerTask = ({ job }) => {
            invoked.push(job.id);
          };
          const registry = new Map([[taskName, task]]);
          const job =
            (await acquireNextDueJob({
              db,
              leaseMs: LEASE_MS,
              now: () => CLOCK_MS,
              registry,
              runnerId: jobId,
            })) ?? panic("Unpaused job must permit acquisition");
          expect(job.pausedUntil).toBeNull();
          await db
            .update(schedulerJobs)
            .set({
              enabled,
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
      },
    );

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
        const job =
          (await acquireNextDueJob({
            db,
            leaseMs: LEASE_MS,
            now: () => CLOCK_MS,
            registry,
            runnerId: jobId,
          })) ?? panic("Unpaused job must permit acquisition");
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
        const job =
          (await acquireNextDueJob({
            db,
            leaseMs: LEASE_MS,
            now: () => CLOCK_MS,
            registry,
            runnerId: jobId,
          })) ?? panic("Unpaused job must permit acquisition");
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
