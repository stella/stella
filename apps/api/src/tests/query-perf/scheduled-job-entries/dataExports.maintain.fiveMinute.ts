import { MAINTAIN_DATA_EXPORTS_TASK } from "@/api/lib/scheduler/tasks/data-export-maintenance";

import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  task: MAINTAIN_DATA_EXPORTS_TASK,
  scenarios: (["quiet", "transitions", "queued"] as const).map((cohort) => ({
    size: { type: "data-exports", rows: 6000, cohort },
    double: { type: "data-exports", rows: 12_000, cohort },
  })),
} as const satisfies ScheduledJobMeasurement;
