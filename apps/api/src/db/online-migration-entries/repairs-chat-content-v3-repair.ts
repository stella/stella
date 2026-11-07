import { CHAT_CONTENT_V3_REPAIR } from "../chat-content-v3-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-chat-content-v3-repair",
  revision: 1020,
  type: "repairs",
  values: [CHAT_CONTENT_V3_REPAIR],
} satisfies OnlineMigrationEntry;
