import { ONLINE_WORK_RUNNER_TASK } from "@/api/lib/scheduler/tasks/online-work-runner";

import { CASE_LAW_SCENARIOS } from "../corpus-seed";
import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  task: ONLINE_WORK_RUNNER_TASK,
  scenarios: Object.values(CASE_LAW_SCENARIOS).map((scenario) => ({
    size: { type: "case-law", served: scenario.size },
    ...("double" in scenario
      ? { double: { type: "case-law" as const, served: scenario.double } }
      : {}),
  })),
} as const satisfies ScheduledJobMeasurement;
