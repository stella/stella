import { SWEEP_REQUEST_RECEIPTS_TASK } from "@/api/lib/scheduler/tasks/request-receipt-retention";

import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  type: "request-receipts",
  task: SWEEP_REQUEST_RECEIPTS_TASK,
  scenarios: (["expired", "quiet", "mixed"] as const).map((cohort) => ({
    size: { type: "request-receipts", rows: 60_000, cohort },
    double: { type: "request-receipts", rows: 120_000, cohort },
  })),
} as const satisfies ScheduledJobMeasurement;
