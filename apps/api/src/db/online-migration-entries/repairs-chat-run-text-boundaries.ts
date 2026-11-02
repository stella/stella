import { CHAT_RUN_TEXT_BOUNDARIES } from "../chat-run-text-boundaries";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-chat-run-text-boundaries",
  revision: 930,
  type: "repairs",
  values: [CHAT_RUN_TEXT_BOUNDARIES],
} satisfies OnlineMigrationEntry;
