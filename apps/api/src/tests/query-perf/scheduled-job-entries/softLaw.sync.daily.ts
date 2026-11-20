import { SYNC_SOFT_LAW_TASK } from "@/api/lib/scheduler/tasks/soft-law-sync";

import type { ScheduledJobMeasurement } from "../measurement-definition";
import { measureSoftLawSyncHistory } from "../soft-law-sync-run";

export default {
  task: SYNC_SOFT_LAW_TASK,
  scenarios: [],
  measure: measureSoftLawSyncHistory,
} as const satisfies ScheduledJobMeasurement;
