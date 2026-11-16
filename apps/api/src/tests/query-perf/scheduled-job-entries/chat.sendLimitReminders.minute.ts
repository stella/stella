import { SEND_CHAT_LIMIT_REMINDERS_TASK } from "@/api/lib/scheduler/tasks/chat-limit-reminders";

import { measureChatLimitReminderHistory } from "../chat-limit-reminder-run";
import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  task: SEND_CHAT_LIMIT_REMINDERS_TASK,
  scenarios: [],
  measure: measureChatLimitReminderHistory,
} as const satisfies ScheduledJobMeasurement;
