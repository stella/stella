import { CHAT_LIMIT_REMINDER_ON_RESET_CONSTRAINTS } from "../chat-limit-reminder-on-reset-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-chat-limit-reminder-on-reset-constraints",
  revision: 1485,
  lifecycle: "pending",
  type: "constraints",
  values: [...CHAT_LIMIT_REMINDER_ON_RESET_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
