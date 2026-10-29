import { panic, Result } from "better-result";
import { type Logger, type SQL, sql } from "drizzle-orm";

import { setSharedQueryTimeouts } from "@/api/db/shared-pool-timeouts";
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

/**
 * Pages one run of a declared job reads. The job's registered task runs once
 * against the fixture through a client that records every statement it
 * issues; each recorded read is then analyzed in one transaction under the
 * committed planner settings, and the run costs the sum. Measuring the task
 * rather than a hand-kept list of its statements means a statement added to
 * the job is measured without anyone registering it.
 *
 * Replayed statements run behind savepoints, so measuring a write reports its
 * reads without changing the fixture the next scenario receives.
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
  const captured: CapturedStatement[] = [];
  const logger: Logger = {
    logQuery: (text, params) => {
      captured.push({ text, params });
    },
  };
  const { db, sql: rawClient } = openClient({
    connection: QUERY_PERF_CONNECTION_SETTINGS,
    logger,
  });
  const task =
    job.task === BACKFILL_CASE_LAW_PROVISION_STATE_TASK
      ? createCaseLawProvisionStateBackfillTask({
          withConnection: async (_options, work) =>
            await work({
              connection: {
                unsafe: async (query, params = []) => {
                  captured.push({ text: query, params });
                  const result: unknown = await rawClient.unsafe(query, [
                    ...params,
                  ]);
                  return result;
                },
              },
              setTransactionBudget: async ({
                lockTimeout,
                statementTimeout,
              }) => {
                await setSharedQueryTimeouts(
                  async (query, params = []) => {
                    captured.push({ text: query, params });
                    const result: unknown = await rawClient.unsafe(query, [
                      ...params,
                    ]);
                    return result;
                  },
                  {
                    lockTimeoutMs: lockTimeout,
                    statementTimeoutMs: statementTimeout,
                  },
                );
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
  const runId = Bun.randomUUIDv7();
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
    return panic(`${jobId} failed on the fixture: ${outcome.error.message}`);
  }
  await database.execute(
    sql`DELETE FROM system_audit_runs WHERE subject = ${runId}`,
  );
  const reads = statementsForMeasurement(jobId, captured);
  if (reads.length === 0) {
    return panic(`${jobId} issued no statement to measure`);
  }
  const statements = await database.transaction(async (tx) => {
    await applyPlannerSettings(tx);
    const measured: { metrics: QueryPerfMetrics; statement: string }[] = [];
    for (const statement of reads) {
      // db-await-in-loop: the run's statements are analyzed one at a time, in the order the job issued them.
      await tx.execute(sql.raw("SAVEPOINT query_perf_statement"));
      const plan = await explainOwnerStatement(tx, asQuery(statement));
      await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT query_perf_statement"));
      measured.push({
        metrics: metricsFromPlan(plan),
        statement: statement.text.replaceAll(/\s+/gu, " ").slice(0, 160),
      });
    }
    await assertPlannerSettings(tx, "owner");
    return measured;
  });
  return {
    metrics: sumMetrics(statements.map(({ metrics }) => metrics)),
    statements,
  };
};
