import type { OnlineMigrationEntry } from "../online-migration-entry";
import { CHAT_TURN_ORDINAL_UNIQUE_INDEXES } from "../online-unique-indexes";

export default {
  id: "indexes-chat-turns-thread-ordinal-uidx",
  revision: 1461,
  type: "indexes",
  values: [...CHAT_TURN_ORDINAL_UNIQUE_INDEXES],
} satisfies OnlineMigrationEntry;
