import { BACKFILL_CASE_LAW_PROVISION_STATE_TASK } from "@/api/lib/scheduler/tasks/case-law-provision-state-backfill";

import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  task: BACKFILL_CASE_LAW_PROVISION_STATE_TASK,
  scenarios: [],
} as const satisfies ScheduledJobMeasurement;
