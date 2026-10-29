import { panic, Result } from "better-result";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { hostedCustomerErasures } from "@/api/db/schema";
import type { TransactionOf } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { HostedUsageProviderApiError } from "@/api/lib/hosted-usage-provider/client";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { ERASE_HOSTED_CUSTOMERS_TASK } from "@/api/lib/scheduler/tasks/hosted-customer-erasure";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  explainOwnerStatement,
  metricsFromPlan,
  type QueryPerfMetrics,
  sumMetrics,
} from "./measurement";
import {
  type CapturedStatement,
  capturedStatementQuery,
} from "./scheduled-run";
import {
  applyPlannerSettings,
  QUERY_PERF_CONNECTION_SETTINGS,
} from "./settings";

type RollbackMeasurementOptions = {
  database: GatedTestDb;
  run: (tx: TransactionOf<GatedTestDb>) => Promise<void>;
};

const rollbackMeasurement = async ({
  database,
  run,
}: RollbackMeasurementOptions) => {
  const outcome = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (tx) => {
        await run(tx);
        tx.rollback();
      }),
    catch: (error: unknown) => error,
  });
  if (
    Result.isOk(outcome) ||
    !(outcome.error instanceof TransactionRollbackError)
  ) {
    panic("A measurement must finish by rolling its transaction back", outcome);
  }
};

const noopTask = () => undefined;
const CONTROL_KEYWORDS = new Set([
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "set",
  "reset",
  "show",
]);
const STATEMENT_KEYWORDS = new Set([
  "select",
  "with",
  "insert",
  "update",
  "delete",
]);

/** Replay the registered writing task's statements in order, then roll back. */
const measureHostedErasureRun = async (
  openClient: GatedTestClientScope["openClient"],
) => {
  const captured: CapturedStatement[] = [];
  let recording = false;
  const { db } = openClient({
    connection: QUERY_PERF_CONNECTION_SETTINGS,
    logger: {
      logQuery: (text, params) => {
        if (recording) {
          captured.push({ text, params });
        }
      },
    },
  });
  const now = new Date("2026-10-29T00:00:00Z");
  const task =
    createSchedulerTaskRegistry(noopTask, noopTask, {
      hostedCustomerErasureDependencies: {
        credentials: { apiKey: "fixture", baseUrl: "https://provider.test" },
        provider: "polar",
        erase: ({ externalCustomerRef }) =>
          Promise.resolve(
            externalCustomerRef.endsWith("0")
              ? Result.err(
                  new HostedUsageProviderApiError({
                    message: "Fixture refusal",
                    status: 503,
                  }),
                )
              : Result.ok(undefined),
          ),
        observe: noopTask,
        now: () => now,
      },
    }).get(ERASE_HOSTED_CUSTOMERS_TASK) ??
    panic("Erasure task is unregistered");
  await rollbackMeasurement({
    database: db,
    run: async (tx) => {
      recording = true;
      await task(
        asTestRaw<SchedulerTaskContext>({
          db: {
            transaction: async <T>(run: (savepoint: typeof tx) => Promise<T>) =>
              await withAggregateSavepoint(tx, run),
          },
          dueAt: DueSlot.of({ nextRunAt: now, lockedAt: now }),
          runId: createSafeId<"schedulerJobRun">(),
          signal: new AbortController().signal,
        }),
      );
      recording = false;
    },
  });
  const statements = captured.filter(({ text }) => {
    const keyword = text.trim().split(/\s+/u).at(0)?.toLowerCase() ?? "";
    if (CONTROL_KEYWORDS.has(keyword)) {
      return false;
    }
    if (!STATEMENT_KEYWORDS.has(keyword)) {
      panic(`Unmeasured erasure statement kind: ${keyword}`);
    }
    return true;
  });
  if (statements.length === 0) {
    panic("Erasure measurement captured no SQL");
  }
  const metrics: QueryPerfMetrics[] = [];
  await rollbackMeasurement({
    database: db,
    run: async (tx) => {
      await applyPlannerSettings(tx);
      for (const statement of statements) {
        // db-await-in-loop: replay one run's captured statements in their original order, inside a rolled-back transaction.
        metrics.push(
          metricsFromPlan(
            await explainOwnerStatement(tx, capturedStatementQuery(statement)),
          ),
        );
      }
    },
  });
  return { metrics: sumMetrics(metrics), statements: statements.length };
};

/** Fixed 25-row work batch, with retained terminal history at two sizes. */
export const measureHostedErasureHistory = async (
  openClient: GatedTestClientScope["openClient"],
) => {
  const { db } = openClient({ connection: QUERY_PERF_CONNECTION_SETTINGS });
  const measurements = [];
  for (const history of [1000, 10_000]) {
    // db-await-in-loop: isolated measurement scenarios run sequentially, each reseeding its own disposable fixture table.
    await db.delete(hostedCustomerErasures).where(sql`true`);
    // db-await-in-loop: seed the terminal history before the fixed eligible batch so a table scan has to cross the history.
    await db.execute(sql`INSERT INTO hosted_customer_erasures (external_customer_ref, status, attempts, next_attempt_at)
      SELECT 'history_' || n, 'failed', 5, '2020-01-01'::timestamptz FROM generate_series(1, ${history}::integer) n`);
    // db-await-in-loop: the same eligible batch is present at both history sizes.
    await db.execute(sql`INSERT INTO hosted_customer_erasures (external_customer_ref, status, attempts, next_attempt_at)
      SELECT 'due_' || n, 'pending', 4, '2020-01-01'::timestamptz FROM generate_series(1, 25) n`);
    // db-await-in-loop: each scenario gets current statistics before the actual task is captured and replayed.
    await db.execute(sql`ANALYZE hosted_customer_erasures`);
    // db-await-in-loop: one measured task run per independently seeded history size.
    measurements.push({
      history,
      ...(await measureHostedErasureRun(openClient)),
    });
  }
  return measurements;
};
