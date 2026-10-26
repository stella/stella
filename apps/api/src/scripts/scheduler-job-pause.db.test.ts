import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { schedulerJobs } from "@/api/db/schema";
import {
  DECLARED_SCHEDULER_JOBS,
  upsertSchedulerJob,
} from "@/api/lib/scheduler/jobs";
import { acquireNextDueJob } from "@/api/lib/scheduler/runner";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  parseSchedulerJobPauseArgs,
  runSchedulerJobPause,
} from "./scheduler-job-pause";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const definition =
  DECLARED_SCHEDULER_JOBS.find(
    ({ id }) => id !== "scheduler.pauseAudit.hourly",
  ) ?? panic("A pausable scheduler job declaration is required");
const actor = "scheduler-test-operator";
const pauseReason = "Runaway test workload";

const command = (action: "pause" | "resume", apply: boolean, duration = "1h") =>
  parseSchedulerJobPauseArgs([
    action,
    "--job",
    definition.id,
    ...(action === "pause" ? ["--for", duration] : []),
    "--reason",
    pauseReason,
    "--actor",
    actor,
    ...(apply ? ["--apply"] : []),
  ]);

describe.skipIf(!runPostgresTests)(
  "scheduler job pause operator script (postgres)",
  () => {
    test("dry run, pause, renewal, status, and resume preserve their invariants", async () => {
      if (databaseUrl === undefined) {
        throw new TypeError("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const lines: string[] = [];
        const write = (line: string) => {
          lines.push(line);
        };
        await db
          .delete(schedulerJobs)
          .where(eq(schedulerJobs.id, definition.id));
        try {
          await upsertSchedulerJob(definition, db);
          await db
            .update(schedulerJobs)
            .set({ nextRunAt: new Date(Date.now() - 60_000) })
            .where(eq(schedulerJobs.id, definition.id));

          await runSchedulerJobPause(command("pause", false), {
            db,
            now: () => new Date("2026-10-26T12:00:00.000Z"),
            write,
          });
          const [afterDryRun] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, definition.id));
          expect(afterDryRun?.pausedUntil).toBeNull();
          expect(lines.some((line) => line === "DRY_RUN apply=false")).toBe(
            true,
          );

          await runSchedulerJobPause(command("pause", true), { db, write });
          const [paused] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, definition.id));
          expect(paused?.pausedSince).toBeInstanceOf(Date);
          expect(paused?.pausedUntil?.getTime()).toBeGreaterThan(Date.now());
          expect(
            await acquireNextDueJob({
              db,
              leaseMs: 180_000,
              now: Date.now,
              registry: new Map([[definition.task, () => undefined]]),
              runnerId: "scheduler-job-pause-test",
            }),
          ).toBeNull();

          await runSchedulerJobPause(command("pause", true, "2h"), {
            db,
            write,
          });
          const [renewed] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, definition.id));
          expect(renewed?.pausedSince).toEqual(paused?.pausedSince);
          expect(renewed?.pausedUntil?.getTime()).toBeGreaterThan(
            paused?.pausedUntil?.getTime() ?? Number.POSITIVE_INFINITY,
          );

          const updatedBeforeStatus = renewed?.updatedAt;
          const status = await runSchedulerJobPause(
            parseSchedulerJobPauseArgs(["status", "--job", definition.id]),
            { db, write },
          );
          expect(status).toHaveLength(1);
          const [afterStatus] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, definition.id));
          expect(afterStatus?.updatedAt).toEqual(updatedBeforeStatus);

          await runSchedulerJobPause(command("resume", true), { db, write });
          const [resumed] = await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, definition.id));
          expect(resumed?.pausedUntil).toBeNull();
        } finally {
          await db
            .delete(schedulerJobs)
            .where(eq(schedulerJobs.id, definition.id));
        }
      });
    });

    test("invalid commands are refused without reaching the database", () => {
      const invalidArguments = [
        [
          "pause",
          "--job",
          definition.id,
          "--for",
          "73h",
          "--reason",
          pauseReason,
          "--actor",
          actor,
        ],
        [
          "pause",
          "--job",
          definition.id,
          "--for",
          "0m",
          "--reason",
          pauseReason,
          "--actor",
          actor,
        ],
        [
          "pause",
          "--job",
          definition.id,
          "--for",
          "1h",
          "--reason",
          "1234567",
          "--actor",
          actor,
        ],
        [
          "pause",
          "--job",
          definition.id,
          "--for",
          "1h",
          "--reason",
          pauseReason,
          "--actor",
          "   ",
        ],
        [
          "pause",
          "--job",
          "unknown.job",
          "--for",
          "1h",
          "--reason",
          pauseReason,
          "--actor",
          actor,
        ],
      ] as const;
      for (const args of invalidArguments) {
        expect(() => parseSchedulerJobPauseArgs(args)).toThrow(
          /(?:72 hours|greater than zero|eight characters|blank|Valid ids)/u,
        );
      }
    });
  },
);
