import { CHAT_TURNS_HANDED_OVER_CONSTRAINTS } from "../chat-turns-handed-over-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-chat-turns-handed-over-constraints",
  revision: 1470,
  type: "constraints",
  values: [...CHAT_TURNS_HANDED_OVER_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
