import { CHAT_TURN_ORDINAL_BACKFILL } from "../chat-turn-ordinal-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-chat-turn-ordinal-backfill",
  revision: 1457,
  type: "repairs",
  values: [CHAT_TURN_ORDINAL_BACKFILL],
} satisfies OnlineMigrationEntry;
