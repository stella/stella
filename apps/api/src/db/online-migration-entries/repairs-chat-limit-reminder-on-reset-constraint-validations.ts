import { CHAT_LIMIT_REMINDER_ON_RESET_CONSTRAINT_VALIDATIONS } from "../chat-limit-reminder-on-reset-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-chat-limit-reminder-on-reset-constraint-validations",
  revision: 1486,
  lifecycle: "pending",
  type: "repairs",
  values: [...CHAT_LIMIT_REMINDER_ON_RESET_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
