import { ERASE_HOSTED_CUSTOMERS_TASK } from "@/api/lib/scheduler/tasks/hosted-customer-erasure";

import { measureHostedErasureHistory } from "../hosted-erasure-run";
import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  task: ERASE_HOSTED_CUSTOMERS_TASK,
  scenarios: [],
  measure: measureHostedErasureHistory,
} as const satisfies ScheduledJobMeasurement;
