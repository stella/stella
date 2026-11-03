import { BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK } from "@/api/lib/scheduler/tasks/legislation-expression-id-backfill";

import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  task: BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK,
  scenarios: [],
} as const satisfies ScheduledJobMeasurement;
