import { panic, Result } from "better-result";
import {
  type Logger,
  type SQL,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";

import { databaseRelations } from "@/api/db/database-relations";
import { setSharedQueryTimeouts } from "@/api/db/shared-pool-timeouts";
import { createDatabase } from "@/api/db/sql-client";
import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { createCaseLawCoverageRefreshTask } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import {
  BACKFILL_CASE_LAW_PROVISION_STATE_TASK,
  createCaseLawProvisionStateBackfillTask,
} from "@/api/lib/scheduler/tasks/case-law-provision-state-backfill";
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
const TRANSACTION_KEYWORDS: ReadonlySet<string> = new Set([
  "begin",
  "commit",
  "lock",
  "rollback",
  "savepoint",
]);

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
    if (SESSION_KEYWORDS.has(keyword) || TRANSACTION_KEYWORDS.has(keyword)) {
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

const noopTask = () => undefined;
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
    const normalized = statement
      .replaceAll(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/gu, "")
      .replaceAll(/;\s*$/gu, "")
      .trim();
    if (
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
export const measureScheduledJobRun = async ({
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
          : (createSchedulerTaskRegistry(
              noopTask,
              createCaseLawCoverageRefreshTask({
                compute: computeCaseLawCoverageAnswer,
              }),
            ).get(job.task) ??
            panic(`No registered task ${job.task} for ${jobId}`));
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
