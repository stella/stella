import { CHAT_TURNS_HANDED_OVER_CONSTRAINT_VALIDATIONS } from "../chat-turns-handed-over-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-chat-turns-handed-over-constraint-validations",
  revision: 1482,
  type: "repairs",
  values: [...CHAT_TURNS_HANDED_OVER_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
