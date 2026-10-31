import { compareCodeUnit } from "@stll/collation";

import type {
  ReadBudgetId,
  ScheduledJobReadBudgetId,
} from "@/api/lib/db/read-budgets";

import type { CorpusReadBudgetSeed } from "./corpus-seed";
import corpusStatements from "./corpus-statement-entries/registry.gen";
import type { ScheduledJobMeasurement } from "./measurement-definition";
import readBudgetProfiles from "./profile-entries/registry.gen";
import scheduledJobMeasurements from "./scheduled-job-entries/registry.gen";
import type { seedQueryPerf } from "./seed";
import tenantStatements from "./tenant-statement-entries/registry.gen";

export type { ScheduledJobScenario } from "./measurement-definition";

/** Tenant statements, measured as `stella` under row security per profile. */
export const queryPerfRegistry = (
  seed: Awaited<ReturnType<typeof seedQueryPerf>>,
) =>
  Object.values(tenantStatements)
    .map((measure) => measure(seed))
    .toSorted((left, right) => compareCodeUnit(left.budgetId, right.budgetId));

/** Public corpus statements, measured on the corpus profile as its owner. */
export const corpusStatementRegistry = (seed: CorpusReadBudgetSeed) =>
  Object.values(corpusStatements)
    .map((measure) => measure(seed))
    .toSorted((left, right) => compareCodeUnit(left.budgetId, right.budgetId));

/**
 * How each budgeted scheduled job is measured, keyed by the job's id: the
 * gate runs that job's registered task against every corpus scenario it can
 * meet, at one size and, where the scenario has one, at twice that size, and
 * judges it against the budget the job's own registration declares. A job
 * that declares a budget without an entry here fails the census
 * (`scheduledJobMeasurementViolations`), however many other jobs share it.
 */
export const SCHEDULED_JOB_MEASUREMENTS: Readonly<
  Record<string, ScheduledJobMeasurement>
> = scheduledJobMeasurements;

type DeclaredJobReads = {
  id: string;
  task: string;
  reads:
    | { budget: ScheduledJobReadBudgetId; governance?: "load-governed" }
    | "load-governed"
    | "unmeasured";
};

/**
 * Every job that declares a read budget has a measurement of its own, for its
 * own task, and every measurement belongs to such a job.
 */
export const scheduledJobMeasurementViolations = (
  jobs: readonly DeclaredJobReads[],
  measurements: Readonly<Record<string, ScheduledJobMeasurement>>,
): string[] => {
  const budgeted = jobs.filter(
    (job): job is DeclaredJobReads & { reads: { budget: string } } =>
      typeof job.reads === "object",
  );
  const declared = new Set(budgeted.map(({ id }) => id));
  return [
    ...budgeted.flatMap((job) => {
      const measurement = measurements[job.id];
      if (measurement === undefined) {
        return [
          `${job.id} declares ${job.reads.budget} but has no measurement keyed by its id`,
        ];
      }
      return measurement.task === job.task
        ? []
        : [
            `${job.id} runs ${job.task}, but its measurement runs ${measurement.task}`,
          ];
    }),
    ...Object.keys(measurements)
      .filter((id) => !declared.has(id))
      .map((id) => `${id} is measured but declares no read budget`),
  ];
};

/** Which profile measures each budget; every budget has exactly one. */
export const READ_BUDGET_PROFILES = readBudgetProfiles satisfies Record<
  ReadBudgetId,
  "corpus" | "tenant" | "case-law" | "coverage"
>;
