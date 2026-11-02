import { CHAT_CONTENT_V3_CONSTRAINTS } from "../chat-content-v3-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-chat-content-v3-constraints",
  revision: 1270,
  type: "constraints",
  values: [...CHAT_CONTENT_V3_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
