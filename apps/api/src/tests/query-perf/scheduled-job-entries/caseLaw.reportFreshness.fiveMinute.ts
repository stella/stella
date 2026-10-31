import { REPORT_CASE_LAW_FRESHNESS_TASK } from "@/api/lib/scheduler/tasks/case-law-freshness-report";

import { CASE_LAW_SCENARIOS } from "../corpus-seed";
import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  // Imported, not spelled: the gate's CI scope follows this module's imports.
  task: REPORT_CASE_LAW_FRESHNESS_TASK,
  scenarios: Object.values(CASE_LAW_SCENARIOS).map((scenario) => ({
    size: { type: "case-law", served: scenario.size },
    ...("double" in scenario
      ? { double: { type: "case-law" as const, served: scenario.double } }
      : {}),
  })),
} as const satisfies ScheduledJobMeasurement;
