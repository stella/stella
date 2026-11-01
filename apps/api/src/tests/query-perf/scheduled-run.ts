import { panic, Result } from "better-result";
import {
  type Logger,
  type SQL,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";

import type { Verdict } from "@stll/db-load-gate/health";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { databaseRelations } from "@/api/db/database-relations";
import type { Transaction } from "@/api/db/root";
import { schedulerJobs } from "@/api/db/schema";
import { setSharedQueryTimeouts } from "@/api/db/shared-pool-timeouts";
import { createDatabase } from "@/api/db/sql-client";
import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { resetLocalCaseLawConfigForTesting } from "@/api/lib/case-law/local-case-law-config";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { READ_COMMITTED_BEGIN } from "@/api/lib/db/read-committed-unit";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { createCaseLawCoverageRefreshTask } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import {
  BACKFILL_CASE_LAW_PROVISION_STATE_TASK,
  createCaseLawProvisionStateBackfillTask,
} from "@/api/lib/scheduler/tasks/case-law-provision-state-backfill";
import { createLegislationExpressionIdBackfill } from "@/api/lib/scheduler/tasks/legislation-expression-id-backfill";
import { readRecoveryScanState } from "@/api/lib/scheduler/tasks/recovery-scan-cursor";
import { RECOVERY_SCAN_IDENTITIES } from "@/api/lib/scheduler/tasks/recovery-scan-identity";
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
import { measureJobStatements } from "./statement-measurement";

export type CapturedStatement = { text: string; params: readonly unknown[] };
type MeasuredStatement = {
  actualRows: number;
  metrics: QueryPerfMetrics;
  planViolations: PlanViolation[];
  statement: string;
};

/** The statement's leading keyword, after comments and whitespace. */
const leadingKeyword = (text: string) =>
  /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*([a-z]+)/iu
    .exec(text)
    ?.at(1)
    ?.toLowerCase() ?? "";

const SESSION_KEYWORDS: ReadonlySet<string> = new Set(["set", "reset", "show"]);
/**
 * Leading keywords of transaction control. The capture maps these to
 * savepoints and the measurement leaves them out, so both read this one set.
 */
const TRANSACTION_KEYWORDS: ReadonlySet<string> = new Set([
  "abort",
  "begin",
  "commit",
  "end",
  "lock",
  "release",
  "rollback",
  "savepoint",
  "start",
]);

export const isTransactionControl = (text: string) =>
  TRANSACTION_KEYWORDS.has(leadingKeyword(text));

const DDL_KEYWORDS: ReadonlySet<string> = new Set([
  "alter",
  "comment",
  "create",
  "drop",
  "grant",
  "revoke",
  "truncate",
]);

export const statementsForMeasurement = (
  jobId: string,
  captured: readonly CapturedStatement[],
): CapturedStatement[] =>
  captured.filter(({ text }) => {
    const keyword = leadingKeyword(text);
    if (SESSION_KEYWORDS.has(keyword) || isTransactionControl(text)) {
      return false;
    }
    if (DDL_KEYWORDS.has(keyword)) {
      return panic(`${jobId} issued unmeasurable DDL: ${text}`);
    }
    return keyword !== "";
  });

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

class CapturedRunRollbackError extends Error {
  override readonly name = "CapturedRunRollbackError";
}

type CaptureSavepoint = { harnessName: string; jobName: string | undefined };

/** Keeps transaction control issued by a captured job inside the capture transaction. */
const captureConnection = (
  transactionClient: { unsafe: (query: string, params?: unknown[]) => unknown },
  captured: CapturedStatement[],
) => {
  const savepoints: CaptureSavepoint[] = [];
  let nextSavepoint = 0;
  const createSavepoint = (jobName?: string) => {
    const harnessName = `query_perf_capture_${String(nextSavepoint)}`;
    nextSavepoint += 1;
    savepoints.push({ harnessName, jobName });
    return `SAVEPOINT ${harnessName}`;
  };
  const topSavepoint = (statement: string) =>
    savepoints.at(-1) ??
    panic(`Captured job ended a transaction it did not begin: ${statement}`);
  const namedSavepoint = (name: string, statement: string) => {
    const index = savepoints.findLastIndex(
      ({ jobName }) => jobName?.toLowerCase() === name.toLowerCase(),
    );
    if (index === -1) {
      return panic(`Captured job named an unknown savepoint: ${statement}`);
    }
    return {
      index,
      savepoint:
        savepoints.at(index) ?? panic("Captured savepoint stack is invalid"),
    };
  };
  const mapTransactionControl = (statement: string) => {
    const keyword = leadingKeyword(statement);
    if (
      !isTransactionControl(statement) &&
      keyword !== "prepare" &&
      keyword !== "set"
    ) {
      return statement;
    }
    const normalized = statement
      .replaceAll(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/gu, "")
      .replaceAll(/;\s*$/gu, "")
      .trim();
    if (
      normalized.toUpperCase() === READ_COMMITTED_BEGIN ||
      /^(?:begin|start\s+transaction)(?:\s+(?:work|transaction))?$/iu.test(
        normalized,
      )
    ) {
      return createSavepoint();
    }
    if (/^(?:commit|end)(?:\s+(?:work|transaction))?$/iu.test(normalized)) {
      const { harnessName } = topSavepoint(statement);
      savepoints.pop();
      return `RELEASE SAVEPOINT ${harnessName}`;
    }
    if (/^rollback(?:\s+(?:work|transaction))?$/iu.test(normalized)) {
      const { harnessName } = topSavepoint(statement);
      savepoints.pop();
      return `ROLLBACK TO SAVEPOINT ${harnessName}`;
    }
    const savepoint = /^savepoint\s+([^\s]+)$/iu.exec(normalized);
    if (savepoint !== null) {
      return createSavepoint(
        savepoint.at(1) ??
          panic(`Captured SAVEPOINT has no name: ${statement}`),
      );
    }
    const release = /^release(?:\s+savepoint)?\s+([^\s]+)$/iu.exec(normalized);
    if (release !== null) {
      const { index, savepoint: target } = namedSavepoint(
        release.at(1) ?? panic(`Captured RELEASE has no name: ${statement}`),
        statement,
      );
      savepoints.splice(index);
      return `RELEASE SAVEPOINT ${target.harnessName}`;
    }
    const rollbackTo =
      /^rollback(?:\s+(?:work|transaction))?\s+to(?:\s+savepoint)?\s+([^\s]+)$/iu.exec(
        normalized,
      );
    if (rollbackTo !== null) {
      const { index, savepoint: target } = namedSavepoint(
        rollbackTo.at(1) ??
          panic(`Captured ROLLBACK TO has no name: ${statement}`),
        statement,
      );
      savepoints.splice(index + 1);
      return `ROLLBACK TO SAVEPOINT ${target.harnessName}`;
    }
    if (
      /^(?:abort|prepare\s+transaction|commit\s+prepared|rollback\s+prepared|set\s+transaction|set\s+session\s+characteristics\s+as\s+transaction)\b/iu.test(
        normalized,
      )
    ) {
      return panic(
        `Captured job issued unsupported transaction control: ${statement}`,
      );
    }
    return statement;
  };
  return {
    assertBalanced: () => {
      if (savepoints.length !== 0) {
        panic("Captured job left a transaction or savepoint open");
      }
    },
    unsafe: async (query: string, params: readonly unknown[] = []) => {
      captured.push({ text: query, params });
      const result: unknown = await transactionClient.unsafe(
        mapTransactionControl(query),
        [...params],
      );
      return result;
    },
  };
};

export const measureScheduledStatementsInOrder = async ({
  database,
  jobId,
  readBudgetId,
  captured,
}: {
  database: GatedTestDb;
  jobId: string;
  readBudgetId: keyof typeof QUERY_PERF_OWNER_DEADLINES;
  captured: readonly CapturedStatement[];
}) => {
  const reads = statementsForMeasurement(jobId, captured);
  if (reads.length === 0) {
    return panic(`${jobId} issued no statement to measure`);
  }
  let statements: MeasuredStatement[] = [];
  await database
    .transaction(async (tx) => {
      await applyPlannerSettings(tx);
      const measured: MeasuredStatement[] = [];
      for (const statement of reads) {
        // db-await-in-loop: replay preserves the job's statement order and state transitions.
        const plan = await explainOwnerStatement(tx, asQuery(statement));
        const actualRows = plan.Plan["Actual Rows"];
        if (typeof actualRows !== "number") {
          panic(`${jobId} statement plan has no numeric Actual Rows`);
        }
        const normalized = statement.text
          .replaceAll(/\s+/gu, " ")
          .slice(0, 160);
        measured.push({
          actualRows,
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
      statements = measured;
      tx.rollback();
    })
    .catch((error: unknown) => {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    });
  return statements;
};

/**
 * Pages one run of a declared job reads. The job's registered task runs once
 * against the fixture through a client that records every statement it
 * issues; each recorded read is then analyzed in one transaction under the
 * committed planner settings, and the run costs the sum. Measuring the task
 * rather than a hand-kept list of its statements means a statement added to
 * the job is measured without anyone registering it.
 *
 * Both passes roll back once complete, so the fixture remains unchanged.
 */
const measureBackfillJobRun = async ({
  database,
  openClient,
  jobId,
  task: taskName,
}: {
  database: GatedTestDb;
  openClient: GatedTestClientScope["openClient"];
  jobId: string;
  task: string;
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
  const captured: CapturedStatement[] = [];
  const logger: Logger = {
    logQuery: (text, params) => {
      captured.push({ text, params });
    },
  };
  const { sql: rawClient } = openClient({
    connection: QUERY_PERF_CONNECTION_SETTINGS,
  });
  const runId = Bun.randomUUIDv7();
  await rawClient
    .begin(async (transactionClient) => {
      const capturedConnection = captureConnection(transactionClient, captured);
      const db = createDatabase({
        client: transactionClient,
        relations: databaseRelations,
        logger,
      });
      db.transaction = async (work) =>
        await new Promise((resolve, reject) => {
          Promise.resolve(Reflect.apply(work, undefined, [db]))
            .then(resolve)
            .catch(reject);
        });
      const task =
        job.task === BACKFILL_CASE_LAW_PROVISION_STATE_TASK
          ? createCaseLawProvisionStateBackfillTask({
              withConnection: async (_options, work) =>
                await work({
                  connection: {
                    unsafe: capturedConnection.unsafe,
                  },
                  setTransactionBudget: async ({
                    lockTimeout,
                    statementTimeout,
                  }) => {
                    await setSharedQueryTimeouts(capturedConnection.unsafe, {
                      lockTimeoutMs: lockTimeout,
                      statementTimeoutMs: statementTimeout,
                    });
                  },
                }),
              readVerdict: async () =>
                await Promise.resolve({
                  kind: "normal",
                  signals: [],
                }),
              observeStatus: noopTask,
              sleep: async () => await Promise.resolve(),
            })
          : createLegislationExpressionIdBackfill({
              readVerdict: async () =>
                await Promise.resolve(QUERY_PERF_ADMISSION),
              observeStatus: noopTask,
            });
      const outcome = await task(
        asTestRaw<SchedulerTaskContext>({
          db,
          job: { id: job.id, task: job.task },
          payload: null,
          runId,
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
      if (outcome !== undefined && !Result.isOk(outcome)) {
        return panic(
          `${jobId} failed on the fixture: ${outcome.error.message}`,
          outcome.error,
        );
      }
      capturedConnection.assertBalanced();
      throw new CapturedRunRollbackError();
    })
    .then(
      () => panic(`${jobId} capture transaction committed`),
      (error: unknown) => {
        if (!(error instanceof CapturedRunRollbackError)) {
          throw error;
        }
      },
    );
  const statements = await measureScheduledStatementsInOrder({
    database,
    jobId,
    readBudgetId,
    captured,
  });
  return {
    metrics: sumMetrics(statements.map(({ metrics }) => metrics)),
    planViolations: statements.flatMap(({ planViolations }) => planViolations),
    statements,
  };
};

/** Lend fixture transactions through the aggregate savepoint owner. */
export const scheduledMeasurementDatabase = (
  tx: Pick<Transaction, "execute" | "transaction">,
) => ({
  transaction: async <T>(run: (child: Transaction) => Promise<T>) =>
    await withAggregateSavepoint(tx, run),
});

const noopTask = () => undefined;

/**
 * The load governor's admission for a measured run. The governor holds work
 * in its configured busy windows, and held work issues only its own
 * bookkeeping, so the measurement admits explicitly and the time of day
 * cannot decide whether the measured work happens.
 */
export const QUERY_PERF_ADMISSION = {
  kind: "normal",
  signals: [],
} as const satisfies Verdict;

/** Measures each statement before its real execution without replaying task results. */
export const measureScheduledJobRunRaw = async ({
  database,
  jobId,
  task: taskName,
  admission = QUERY_PERF_ADMISSION,
  now = new Date("2026-01-10T12:00:00Z"),
}: {
  database: GatedTestDb;
  jobId: string;
  task: string;
  /** The governor's verdict; a test passes a hold to prove the measurement notices one. */
  admission?: Verdict;
  now?: Date;
}) => {
  const job =
    DECLARED_SCHEDULER_JOBS.find(({ id }) => id === jobId) ??
    panic(`No declared scheduler job ${jobId}`);
  if (job.task !== taskName) {
    return panic(`${jobId} runs ${job.task}, not ${taskName}`);
  }
  const task =
    createSchedulerTaskRegistry(
      noopTask,
      createCaseLawCoverageRefreshTask({
        compute: computeCaseLawCoverageAnswer,
        createRuntime: (options) =>
          createScriptBackfillRuntime({
            ...options,
            readVerdict: async () => await Promise.resolve(admission),
          }),
      }),
    ).get(job.task) ?? panic(`No registered task ${job.task} for ${jobId}`);
  const leaseToken = `query-perf-${createSafeId<"schedulerJobRun">()}`;
  const persistedJob =
    (
      await database
        .insert(schedulerJobs)
        .values({
          id: job.id,
          task: job.task,
          description: job.description,
          schedule: job.schedule,
          payload: "payload" in job ? job.payload : null,
          enabled: true,
          nextRunAt: now,
          lockedAt: now,
          lockedBy: leaseToken,
          lockedUntil: new Date(now.getTime() + 60_000),
        })
        .onConflictDoUpdate({
          target: schedulerJobs.id,
          set: {
            lockedAt: now,
            lockedBy: leaseToken,
            lockedUntil: new Date(now.getTime() + 60_000),
          },
        })
        .returning()
    ).at(0) ?? panic("Scheduled measurement requires its persisted job lease");
  const execution = Object.values(RECOVERY_SCAN_IDENTITIES).some(
    (identity) => identity.task === persistedJob.task,
  )
    ? ({
        type: "recovery",
        phase: readRecoveryScanState(persistedJob, persistedJob.payload).value
          .phase,
      } as const)
    : ({ type: "task" } as const);
  // The search configuration is cached for 60 s, and the scheduled jobs run
  // minutes apart, so a production run reads it cold. Every measured run does
  // too, instead of depending on what an earlier run left in the cache.
  resetPublicCaseLawConfigForTesting();
  resetLocalCaseLawConfigForTesting();
  const measured = await measureJobStatements({
    database,
    run: async (measuredDatabase) =>
      await runWithQueryCounter(async (counter) => {
        const outcome = await task(
          asTestRaw<SchedulerTaskContext>({
            db: measuredDatabase,
            dueAt: DueSlot.of({ nextRunAt: now, lockedAt: now }),
            job: persistedJob,
            payload: persistedJob.payload,
            runId: createSafeId<"schedulerJobRun">(),
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
        return {
          outcome,
          statementCounts: {
            statements: counter.count,
            transactionRoundTrips: counter.transactions,
          },
        };
      }),
  });
  const outcome = measured.value.outcome;
  if (outcome !== undefined && !Result.isOk(outcome)) {
    panic(`${jobId} failed on the fixture: ${outcome.error.message}`);
  }
  if (measured.statements.length === 0) {
    return panic(`${jobId} issued no statement to measure`);
  }
  const statements = measured.statements.map(({ query, plan }) => ({
    metrics: metricsFromPlan(plan),
    plan,
    statement: query.text.replaceAll(/\s+/gu, " ").slice(0, 160),
  }));
  return {
    execution,
    executedStatements: measured.executed,
    statementCounts: measured.value.statementCounts,
    metrics: sumMetrics(statements.map(({ metrics }) => metrics)),
    statements,
  };
};

/** Applies the committed owner deadline and plan rules to a measured run. */
export const measureScheduledJobRun = async (options: {
  database: GatedTestDb;
  jobId: string;
  task: string;
  /** The governor's verdict; a test passes a hold to prove the measurement notices one. */
  admission?: Verdict;
  now?: Date;
}) => {
  const job =
    DECLARED_SCHEDULER_JOBS.find(({ id }) => id === options.jobId) ??
    panic(`No declared scheduler job ${options.jobId}`);
  if (job.task !== options.task) {
    return panic(`${options.jobId} runs ${job.task}, not ${options.task}`);
  }
  const readBudgetId =
    typeof job.reads === "object"
      ? job.reads.budget
      : panic(`${options.jobId} has no measured read budget`);
  const run = await measureScheduledJobRunRaw(options);
  const statements = run.statements.map(({ metrics, plan, statement }) => ({
    metrics,
    planViolations: analyzePlan({
      document: plan,
      owner: options.jobId,
      ownerDeadlineMs: QUERY_PERF_OWNER_DEADLINES[readBudgetId],
      statement,
      profileId: "corpus",
    }),
    statement,
  }));
  return {
    budgetId: readBudgetId,
    execution: run.execution,
    executedStatements: run.executedStatements,
    statementCounts: run.statementCounts,
    metrics: run.metrics,
    planViolations: statements.flatMap(({ planViolations }) => planViolations),
    statements,
  };
};

/**
 * Measures one run of any declared job: backfills through their dedicated
 * captured connection, every other task in the fixture transaction.
 */
export const measureDeclaredJobRun = async ({
  openClient,
  ...options
}: Parameters<typeof measureScheduledJobRun>[0] & {
  openClient?: GatedTestClientScope["openClient"];
}) => {
  if (
    options.jobId === SCHEDULER_BACKFILL_IDS.provisionState ||
    options.jobId === SCHEDULER_BACKFILL_IDS.expressionIds
  ) {
    if (openClient === undefined) {
      return panic(
        `${options.jobId} measurement requires its dedicated connection`,
      );
    }
    return await measureBackfillJobRun({
      database: options.database,
      openClient,
      jobId: options.jobId,
      task: options.task,
    });
  }
  const run = await measureScheduledJobRun(options);
  return {
    metrics: run.metrics,
    planViolations: run.planViolations,
    statements: run.statements,
  };
};
