import { panic, Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import { computeCaseLawCoverageAnswer } from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
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

/** Lend fixture transactions through the aggregate savepoint owner. */
export const scheduledMeasurementDatabase = (
  tx: Pick<Transaction, "execute" | "transaction">,
) => ({
  transaction: async <T>(run: (child: Transaction) => Promise<T>) =>
    await withAggregateSavepoint(tx, run),
});

const noopTask = () => undefined;

/** Measure the registered task's actual statements without replaying its results. */
export const measureScheduledJobRun = async ({
  database,
  jobId,
  task: taskName,
  now = new Date("2026-01-10T12:00:00Z"),
}: {
  database: GatedTestDb;
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
  const measured = await measureJobStatements({
    database,
    run: async (db) =>
      await task(
        asTestRaw<SchedulerTaskContext>({
          db,
          job: { id: job.id, task: job.task },
          payload: "payload" in job ? job.payload : null,
          dueAt: DueSlot.of({ nextRunAt: now, lockedAt: now }),
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
