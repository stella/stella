import { panic, Result } from "better-result";
import { TransactionRollbackError } from "drizzle-orm";

import type { TransactionOf } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import type {
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
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
  classifyMeasuredStatement,
} from "./scheduled-run";
import {
  applyPlannerSettings,
  QUERY_PERF_CONNECTION_SETTINGS,
} from "./settings";
import { capturedStatementQuery } from "./statement-measurement";

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

type ScheduledTaskReplayOptions = {
  openClient: GatedTestClientScope["openClient"];
  /** What the measured job is called in failures. */
  label: string;
  task: SchedulerTask;
  /** The slot the run is due for and claimed at. */
  now: Date;
};

/**
 * Run a registered writing task once inside a rolled-back transaction while
 * recording its statements, then replay those statements in order under
 * `EXPLAIN (ANALYZE, BUFFERS)`, rolled back too, and sum what its reads and
 * its writes touched.
 */
export const measureScheduledTaskReplay = async ({
  openClient,
  label,
  task,
  now,
}: ScheduledTaskReplayOptions) => {
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
          logger,
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
      panic(`Unmeasured ${label} statement kind: ${keyword}`);
    }
    return true;
  });
  if (statements.length === 0) {
    panic(`${label} measurement captured no SQL`);
  }
  const measured: {
    kind: "read" | "write";
    metrics: QueryPerfMetrics;
    writtenRows: number;
  }[] = [];
  await rollbackMeasurement({
    database: db,
    run: async (tx) => {
      await applyPlannerSettings(tx);
      for (const statement of statements) {
        // db-await-in-loop: replay one run's captured statements in their original order, inside a rolled-back transaction.
        const plan = await explainOwnerStatement(
          tx,
          capturedStatementQuery(statement),
        );
        measured.push({
          ...classifyMeasuredStatement({
            statement: statement.text,
            plan: plan.Plan,
          }),
          metrics: metricsFromPlan(plan),
        });
      }
    },
  });
  const metricsOf = (kind?: "read" | "write") =>
    sumMetrics(
      measured
        .filter((statement) => kind === undefined || statement.kind === kind)
        .map(({ metrics }) => metrics),
    );
  return {
    metrics: metricsOf(),
    readMetrics: metricsOf("read"),
    writeMetrics: metricsOf("write"),
    writtenRows: measured.reduce(
      (total, { writtenRows }) => total + writtenRows,
      0,
    ),
    statements: statements.length,
  };
};
