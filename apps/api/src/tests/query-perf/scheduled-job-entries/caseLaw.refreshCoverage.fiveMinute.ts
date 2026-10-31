import { REFRESH_CASE_LAW_COVERAGE_TASK } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";

import {
  CASE_LAW_SCENARIOS,
  coverageRefreshWroteSummary,
  prepareCoverageRefreshMeasurement,
} from "../corpus-seed";
import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  type: "case-law",
  task: REFRESH_CASE_LAW_COVERAGE_TASK,
  prepare: prepareCoverageRefreshMeasurement,
  executed: coverageRefreshWroteSummary,
  scenarios: [
    {
      size: { type: "case-law", served: CASE_LAW_SCENARIOS.quiet.size },
      double: { type: "case-law", served: CASE_LAW_SCENARIOS.quiet.double },
    },
  ],
} as const satisfies ScheduledJobMeasurement;
