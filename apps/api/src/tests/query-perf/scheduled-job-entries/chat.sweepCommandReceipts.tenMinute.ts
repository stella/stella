import { SWEEP_CHAT_COMMAND_RECEIPTS_TASK } from "@/api/lib/scheduler/tasks/chat-command-receipt-retention";

import { measureChatCommandReceiptSweepHistory } from "../chat-command-receipt-sweep-run";
import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  task: SWEEP_CHAT_COMMAND_RECEIPTS_TASK,
  scenarios: [],
  measure: measureChatCommandReceiptSweepHistory,
} as const satisfies ScheduledJobMeasurement;
