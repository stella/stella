import { Err, panic, Result } from "better-result";
import type { SQL } from "bun";
import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { createHeavyWorkSlot } from "@stll/db-load-gate/slot";
import {
  PROVISION_EXTRACTION_ADMISSION,
  PROVISION_EXTRACTION_ADMISSION_REVISION,
} from "@stll/legal-atlas/provision-extraction-admission";

import { BackfillFailedError } from "@/api/db/backfill-runtime";
import {
  withDedicatedReservedSession,
  type withLongRunningConnection,
} from "@/api/db/long-running-connection";
import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { logger } from "@/api/lib/observability/logger";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  SCHEDULER_BACKFILL_CONFIG,
  SCHEDULER_BACKFILL_IDS,
} from "@/api/lib/scheduler/backfill-config";
import { runSchedulerOnce } from "@/api/lib/scheduler/runner";
import type {
  SchedulerDb,
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { createCaseLawProvisionStateBackfillTask } from "./case-law-provision-state-backfill";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type FixtureOptions = {
  phase?: "initial" | "resumed";
  statementTimeoutMs?: number;
  beforeQuery?: (
    statement: string,
    session: Awaited<ReturnType<SQL["reserve"]>>,
  ) => Promise<void>;
};
const withFixture = async (
  work: (fixture: {
    createTask: (options?: FixtureOptions) => {
      task: SchedulerTask;
      run: () => Promise<Awaited<ReturnType<SchedulerTask>>>;
      events: string[];
      failures: unknown[];
    };
    operator: SQL;
    schema: string;
    checkpoint: () => Promise<{
      batch: {
        stableBatches: number;
        heldSince: number | null;
        holdUntil: number | null;
      };
    }>;
  }) => Promise<void>,
) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const operator = openClient().sql;
    const schema = `provision_task_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await operator.unsafe(`CREATE SCHEMA ${schema}`);
    try {
      for (const table of [
        "database_backfill_states",
        "case_law_decisions",
        "case_law_provision_repair_cursors",
        "case_law_provision_admission",
        "case_law_provision_extraction_scopes",
        "case_law_provision_scope_transitions",
        "case_law_provision_citations",
      ]) {
        await operator.unsafe(
          `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`,
        );
      }
      const constraints = await operator.unsafe<{ name: string }[]>(
        `SELECT conname AS name FROM pg_constraint WHERE conrelid = '${schema}.case_law_provision_citations'::regclass AND contype = 'c' AND NOT convalidated`,
      );
      for (const { name } of constraints) {
        await operator.unsafe(
          `ALTER TABLE ${schema}.case_law_provision_citations VALIDATE CONSTRAINT "${name.replaceAll('"', '""')}"`,
        );
      }
      await operator.unsafe(
        `INSERT INTO ${schema}.case_law_provision_admission (key, revision) VALUES ('global', $1)`,
        [PROVISION_EXTRACTION_ADMISSION_REVISION],
      );
      for (const { jurisdiction, language } of Object.values(
        PROVISION_EXTRACTION_ADMISSION,
      )) {
        await operator.unsafe(
          `INSERT INTO ${schema}.case_law_provision_extraction_scopes (country, language, status, generation) VALUES ($1, $2, 'active', 1)`,
          [jurisdiction, language],
        );
      }
      const checkpoint = async () => {
        const row = (
          await operator.unsafe<
            {
              batch: {
                stableBatches: number;
                heldSince: number | null;
                holdUntil: number | null;
              };
            }[]
          >(
            `SELECT batch FROM ${schema}.database_backfill_states WHERE name = $1`,
            [SCHEDULER_BACKFILL_IDS.provisionState],
          )
        ).at(0);
        return row ?? panic("missing provision task checkpoint");
      };
      let now = Date.parse("2026-10-02T12:00:00Z");
      const createTask = ({
        phase = "initial",
        statementTimeoutMs,
        beforeQuery = async () => {},
      }: FixtureOptions = {}) => {
        // A resumed worker must start after any hold persisted by earlier runs.
        if (phase === "resumed") {
          now += SCHEDULER_BACKFILL_CONFIG.holdBackoffCapMs;
        }
        const events: string[] = [];
        const failures: unknown[] = [];
        const controller = new AbortController();
        const withConnection: typeof withLongRunningConnection = async (
          { signal },
          body,
        ) =>
          await withDedicatedReservedSession({
            reserve: async () => {
              const session = await openClient().sql.reserve();
              await session.unsafe(`SET search_path TO ${schema}, public`);
              return session;
            },
            cancelBackend: async (pid) =>
              await operator.unsafe("SELECT pg_cancel_backend($1)", [pid]),
            signal,
            work: async (session, setTransactionBudget) =>
              await body(
                asTestRaw<
                  Parameters<Parameters<typeof withLongRunningConnection>[1]>[0]
                >({
                  connection: {
                    unsafe: async (
                      statement: string,
                      parameters: unknown[] = [],
                    ) => {
                      await beforeQuery(statement, session);
                      // Production catalog reads intentionally name public; isolate
                      // those reads alongside the real cloned constraints here.
                      const isolated = statement
                        .replace(
                          "table_namespace.nspname = 'public'",
                          () => `table_namespace.nspname = '${schema}'`,
                        )
                        .replace(
                          'public."case_law_provision_citations"',
                          () => `${schema}."case_law_provision_citations"`,
                        );
                      return await session.unsafe(isolated, parameters);
                    },
                  },
                  setTransactionBudget: async (budget: {
                    statementTimeout: number;
                    lockTimeout: number;
                  }) =>
                    await setTransactionBudget({
                      statementTimeout:
                        statementTimeoutMs ?? budget.statementTimeout,
                      lockTimeout: budget.lockTimeout,
                    }),
                }),
              ),
          });
        const actualTask = createCaseLawProvisionStateBackfillTask({
          withConnection,
          clock: () => now++,
          readVerdict: async () => ({ kind: "normal", signals: [] }),
          observeStatus: () => {},
          sleep: async () => {},
        });
        const task: SchedulerTask = async (context) => {
          const outcome = await actualTask(context);
          if (outcome instanceof Err) {
            failures.push(outcome.error.cause);
          }
          return outcome;
        };
        return {
          task,
          events,
          failures,
          run: async () =>
            await task(
              asTestRaw<SchedulerTaskContext>({
                signal: controller.signal,
                logger: {
                  ...logger,
                  info: (event: string) => {
                    events.push(event);
                  },
                },
              }),
            ),
        };
      };
      await work({ createTask, operator, schema, checkpoint });
    } finally {
      await operator.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    }
  });
};

describe.skipIf(!enabled)("provision task on PostgreSQL", () => {
  test("a real statement timeout fails the scheduled unit and preserves its cursor", async () => {
    await withFixture(async ({ createTask, operator, schema }) => {
      const task = createTask({
        statementTimeoutMs: 30,
        beforeQuery: async (statement, session) => {
          if (statement.includes("ORDER BY case_law_decisions.id LIMIT")) {
            await session.unsafe("SELECT pg_sleep(1)");
          }
        },
      });
      const schedulerClient = await createTestPglite();
      const failureLog = spyOn(logger, "error");
      try {
        const schedulerDb = drizzle({ client: schedulerClient });
        const jobId = "test.provision.postgres-timeout";
        await schedulerDb.insert(schedulerJobs).values({
          id: jobId,
          task: "caseLaw.backfillProvisionState",
          description: "Real PostgreSQL provision timeout regression",
          enabled: true,
          nextRunAt: new Date(0),
          schedule: { type: "interval", everyMs: 60_000 },
        });
        const result = await runSchedulerOnce({
          db: asTestRaw<SchedulerDb>(schedulerDb),
          registry: new Map([["caseLaw.backfillProvisionState", task.task]]),
          runnerId: "provision-postgres-fixture",
          leaseMs: 180_000,
          maxRuntimeMs: 30_000,
        });
        expect(result).toMatchObject({ failed: 1, succeeded: 0 });
        expect(failureLog).toHaveBeenCalledTimes(1);
        expect(failureLog).toHaveBeenCalledWith(
          "scheduler.job_failed",
          expect.objectContaining({ "error.cause.pg_code": "57014" }),
        );
        const run = (
          await schedulerDb
            .select()
            .from(schedulerJobRuns)
            .where(eq(schedulerJobRuns.jobId, jobId))
        ).at(0);
        expect(run?.status).toBe("failed");
        const job = (
          await schedulerDb
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId))
        ).at(0);
        expect(job?.lastSuccessAt).toBeNull();
        expect(job?.lastError).not.toBeNull();
        expect(job?.lockedBy).toBeNull();
      } finally {
        failureLog.mockRestore();
        await schedulerClient.close();
      }
      expect(task.events).toEqual([]);
      expect(task.failures).toHaveLength(1);
      const failure = task.failures.at(0);
      expect(failure).toMatchObject({ cause: expect.any(BackfillFailedError) });
      expect(isPgError(failure, PG_ERROR.QUERY_CANCELED)).toBe(true);
      expect(
        await operator.unsafe<{ name: string }[]>(
          `SELECT name FROM ${schema}.case_law_provision_repair_cursors`,
        ),
      ).toHaveLength(0);
      const resumed = createTask({ phase: "resumed" });
      await resumed.run();
      expect(resumed.failures).toEqual([]);
      expect(
        await operator.unsafe<{ name: string }[]>(
          `SELECT name FROM ${schema}.case_law_provision_repair_cursors WHERE completed_at IS NOT NULL`,
        ),
      ).toHaveLength(2);
    });
  }, 120_000);

  test("a resumed provision worker completes after a shared-slot hold", async () => {
    await withFixture(async ({ createTask, operator, schema, checkpoint }) => {
      const session = await operator.reserve();
      const slot = createHeavyWorkSlot({
        kind: "operator_job",
        session: {
          query: async (statement, parameters) =>
            await session.unsafe<{ acquired: boolean }[]>(statement, [
              ...parameters,
            ]),
        },
      });
      const held = createTask();
      try {
        expect(await slot.tryAcquire()).toEqual(Result.ok(true));
        await held.run();
        expect(held.failures).toEqual([]);
        expect((await checkpoint()).batch.holdUntil).not.toBeNull();
        expect(
          await operator.unsafe(
            `SELECT name FROM ${schema}.case_law_provision_repair_cursors WHERE completed_at IS NOT NULL`,
          ),
        ).toHaveLength(0);
      } finally {
        await slot.close();
        session.release();
      }
      const resumed = createTask({ phase: "resumed" });
      await resumed.run();
      expect(resumed.failures).toEqual([]);
      expect(
        await operator.unsafe(
          `SELECT name FROM ${schema}.case_law_provision_repair_cursors WHERE completed_at IS NOT NULL`,
        ),
      ).toHaveLength(2);
      expect((await checkpoint()).batch.heldSince).toBeNull();
    });
  });

  test("two workers finishing the real provision steps converge on completion", async () => {
    await withFixture(async ({ createTask, operator, schema, checkpoint }) => {
      const first = createTask();
      const second = createTask();
      await Promise.all([first.run(), second.run()]);
      // A worker refused the shared slot may leave a durable hold. A later
      // completed run must safely settle the same checkpoint under its lock.
      const resumed = createTask({ phase: "resumed" });
      await resumed.run();
      expect([
        ...first.failures,
        ...second.failures,
        ...resumed.failures,
      ]).toEqual([]);
      expect(
        await operator.unsafe<{ name: string }[]>(
          `SELECT name FROM ${schema}.case_law_provision_repair_cursors WHERE completed_at IS NOT NULL`,
        ),
      ).toHaveLength(2);
      expect((await checkpoint()).batch.stableBatches).toBe(0);
      expect((await checkpoint()).batch.heldSince).toBeNull();
    });
  });

  test("a killed worker after the last page resumes completion without replaying pages", async () => {
    await withFixture(async ({ createTask, operator, schema, checkpoint }) => {
      let reads = 0;
      const killed = createTask({
        beforeQuery: async (statement, session) => {
          if (!statement.includes("SELECT cursor, batch") || ++reads !== 3) {
            return;
          }
          const pid = (
            await session.unsafe<{ pid: number }[]>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).at(0)?.pid;
          if (pid === undefined) {
            panic("missing worker pid");
          }
          await operator.unsafe("SELECT pg_terminate_backend($1)", [pid]);
        },
      });
      await killed.run();
      expect(killed.failures).toHaveLength(1);
      expect(
        await operator.unsafe<{ name: string }[]>(
          `SELECT name FROM ${schema}.case_law_provision_repair_cursors WHERE completed_at IS NOT NULL`,
        ),
      ).toHaveLength(2);
      expect((await checkpoint()).batch.stableBatches).toBe(2);
      const resumed = createTask({ phase: "resumed" });
      await resumed.run();
      expect(resumed.failures).toEqual([]);
      expect((await checkpoint()).batch.stableBatches).toBe(0);
    });
  });
});
