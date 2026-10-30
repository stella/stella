import { panic, Result } from "better-result";

import type { Verdict } from "@stll/db-load-gate/health";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { schedulerJobs } from "@/api/db/schema";
import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { resetLocalCaseLawConfigForTesting } from "@/api/lib/case-law/local-case-law-config";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { createCaseLawCoverageRefreshTask } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import { readRecoveryScanState } from "@/api/lib/scheduler/tasks/recovery-scan-cursor";
import { RECOVERY_SCAN_IDENTITIES } from "@/api/lib/scheduler/tasks/recovery-scan-identity";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { metricsFromPlan, sumMetrics } from "./measurement";
import { QUERY_PERF_OWNER_DEADLINES } from "./owner-deadlines";
import { analyzePlan } from "./plan-analyzer";
import { measureJobStatements } from "./statement-measurement";

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
