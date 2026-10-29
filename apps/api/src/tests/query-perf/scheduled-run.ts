import { panic, Result } from "better-result";

import type { Verdict } from "@stll/db-load-gate/health";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { createCaseLawCoverageRefreshTask } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
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
 * in its busy windows (06:30-08:00 Europe/Prague by default), and held work
 * issues only its own bookkeeping, so the measurement admits explicitly and
 * the time of day cannot decide whether the measured work happens.
 */
export const QUERY_PERF_ADMISSION = {
  kind: "normal",
  signals: [],
} as const satisfies Verdict;

/** Measure the registered task's actual statements without replaying its results. */
export const measureScheduledJobRun = async ({
  database,
  jobId,
  task: taskName,
  admission = QUERY_PERF_ADMISSION,
}: {
  database: GatedTestDb;
  jobId: string;
  task: string;
  /** The governor's verdict; a test passes a hold to prove the measurement notices one. */
  admission?: Verdict;
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
        createRuntime: (options) =>
          createScriptBackfillRuntime({
            ...options,
            readVerdict: async () => await Promise.resolve(admission),
          }),
      }),
    ).get(job.task) ?? panic(`No registered task ${job.task} for ${jobId}`);
  const measured = await measureJobStatements({
    database,
    run: async (db) =>
      await task(
        asTestRaw<SchedulerTaskContext>({
          db,
          job: { id: job.id, task: job.task },
          payload: null,
          dueAt: DueSlot.of({ nextRunAt: new Date("2000-01-01") }),
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
      ),
  });
  const outcome = measured.value;
  if (outcome !== undefined && !Result.isOk(outcome)) {
    return panic(`${jobId} failed on the fixture: ${outcome.error.message}`);
  }
  if (measured.statements.length === 0) {
    return panic(`${jobId} issued no statement to measure`);
  }
  const statements = measured.statements.map(({ query, plan }) => {
    const statement = query.text.replaceAll(/\s+/gu, " ").slice(0, 160);
    return {
      metrics: metricsFromPlan(plan),
      planViolations: analyzePlan({
        document: plan,
        owner: jobId,
        ownerDeadlineMs: QUERY_PERF_OWNER_DEADLINES[readBudgetId],
        statement,
        profileId: "corpus",
      }),
      statement,
    };
  });
  return {
    metrics: sumMetrics(statements.map(({ metrics }) => metrics)),
    planViolations: statements.flatMap(({ planViolations }) => planViolations),
    statements,
  };
};
