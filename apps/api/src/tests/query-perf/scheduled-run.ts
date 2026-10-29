import { panic, Result } from "better-result";
import {
  type Logger,
  type SQL,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { createCaseLawCoverageRefreshTask } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
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
import { QUERY_PERF_OWNER_DEADLINES } from "./owner-deadlines";
import { analyzePlan, type PlanViolation } from "./plan-analyzer";
import {
  applyPlannerSettings,
  assertPlannerSettings,
  QUERY_PERF_CONNECTION_SETTINGS,
} from "./settings";

type CapturedStatement = { text: string; params: readonly unknown[] };

/** The statement's leading keyword, after comments and whitespace. */
const leadingKeyword = (text: string) =>
  /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*([a-z]+)/iu
    .exec(text)
    ?.at(1)
    ?.toLowerCase() ?? "";

const SESSION_KEYWORDS: ReadonlySet<string> = new Set(["set", "reset", "show"]);
const TRANSACTION_KEYWORDS = new Set([
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
]);
const MEASURED_KEYWORDS: ReadonlySet<string> = new Set([
  "select",
  "with",
  "values",
  "delete",
]);

/** A captured statement as a Drizzle query with the same bound parameters. */
const asQuery = ({ text, params }: CapturedStatement): SQL => {
  const parts = text.split(/\$(\d+)/u);
  const chunks = parts.map((part, index) => {
    if (index % 2 === 0) {
      return sql.raw(part);
    }
    const position = Number(part) - 1;
    if (position < 0 || position >= params.length) {
      return panic(`Captured statement names missing parameter $${part}`);
    }
    // One bound value each, as captured: an array stays one array parameter.
    return sql.param(params[position]);
  });
  return sql.join(chunks, sql.raw(""));
};

/** Lend root-shaped transactions while preserving the aggregate savepoint owner. */
export const scheduledMeasurementDatabase = (
  tx: Pick<Transaction, "execute" | "transaction">,
) => ({
  transaction: async <T>(run: (child: Transaction) => Promise<T>) =>
    await withAggregateSavepoint(tx, run),
});

const noopTask = () => undefined;

/**
 * Pages one run of a declared job reads. The job's registered task runs once
 * against the fixture through a client that records every statement it
 * issues; each recorded read is then analyzed in one transaction under the
 * committed planner settings, and the run costs the sum. Measuring the task
 * rather than a hand-kept list of its statements means a statement added to
 * the job is measured without anyone registering it.
 *
 * Both the registered task and its analyzed replay roll back, so retention
 * deletes are measured without consuming the fixture needed by later runs.
 */
export const measureScheduledJobRun = async ({
  database,
  openClient,
  jobId,
  task: taskName,
  now = new Date("2026-01-10T12:00:00Z"),
}: {
  database: GatedTestDb;
  openClient: GatedTestClientScope["openClient"];
  jobId: string;
  task: string;
  now?: Date;
}) => {
  const job =
    DECLARED_SCHEDULER_JOBS.find(({ id }) => id === jobId) ??
    panic(`No declared scheduler job ${jobId}`);
  if (job.task !== taskName) {
    return panic(`${jobId} runs ${job.task}, not ${taskName}`);
  }
  const readBudgetId =
    typeof job.reads === "object"
      ? job.reads.budget
      : panic(`${jobId} has no measured read budget`);
  const task =
    createSchedulerTaskRegistry(
      noopTask,
      createCaseLawCoverageRefreshTask({
        compute: computeCaseLawCoverageAnswer,
      }),
    ).get(job.task) ?? panic(`No registered task ${job.task} for ${jobId}`);
  const captured: CapturedStatement[] = [];
  const logger: Logger = {
    logQuery: (text, params) => {
      captured.push({ text, params });
    },
  };
  const { db } = openClient({
    connection: QUERY_PERF_CONNECTION_SETTINGS,
    logger,
  });
  const outcome = await Result.tryPromise({
    try: async () =>
      await db.transaction(async (tx) => {
        const result = await task(
          asTestRaw<SchedulerTaskContext>({
            db: scheduledMeasurementDatabase(tx),
            dueAt: DueSlot.of({ nextRunAt: now, lockedAt: now }),
            job: { id: job.id, task: job.task },
            payload: "payload" in job ? job.payload : null,
            signal: new AbortController().signal,
            scheduleContinuation: noopTask,
            logger: {
              debug: noopTask,
              error: noopTask,
              info: noopTask,
              warn: noopTask,
            },
          }),
        );
        if (result !== undefined && !Result.isOk(result)) {
          panic(`${jobId} failed on the fixture: ${result.error.message}`);
        }
        tx.rollback();
      }),
    catch: (error: unknown) => error,
  });
  if (outcome.isOk() || !(outcome.error instanceof TransactionRollbackError)) {
    return panic("Scheduled measurement task must roll back", outcome);
  }
  const reads = captured.filter(({ text }) => {
    const keyword = leadingKeyword(text);
    if (SESSION_KEYWORDS.has(keyword) || TRANSACTION_KEYWORDS.has(keyword)) {
      return false;
    }
    if (!MEASURED_KEYWORDS.has(keyword)) {
      return panic(
        `${jobId} issued an unsupported ${keyword || "blank"} statement`,
      );
    }
    return true;
  });
  if (reads.length === 0) {
    return panic(`${jobId} issued no statement to measure`);
  }
  const statements: {
    metrics: QueryPerfMetrics;
    planViolations: PlanViolation[];
    statement: string;
  }[] = [];
  const replay = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (tx) => {
        await applyPlannerSettings(tx);
        for (const statement of reads) {
          // db-await-in-loop: analyze the captured statements in their original order.
          const plan = await explainOwnerStatement(tx, asQuery(statement));
          const normalized = statement.text
            .replaceAll(/\s+/gu, " ")
            .slice(0, 160);
          statements.push({
            metrics: metricsFromPlan(plan),
            planViolations: analyzePlan({
              document: plan,
              owner: jobId,
              ownerDeadlineMs: QUERY_PERF_OWNER_DEADLINES[readBudgetId],
              statement: normalized,
              profileId: "corpus",
            }),
            statement: normalized,
          });
        }
        await assertPlannerSettings(tx, "owner");
        tx.rollback();
      }),
    catch: (error: unknown) => error,
  });
  if (replay.isOk() || !(replay.error instanceof TransactionRollbackError)) {
    return panic("Scheduled measurement replay must roll back", replay);
  }
  return {
    metrics: sumMetrics(statements.map(({ metrics }) => metrics)),
    planViolations: statements.flatMap(({ planViolations }) => planViolations),
    statements,
  };
};
