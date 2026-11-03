import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-chat-turns-org-run-id-uidx",
  revision: 680,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.CHAT_TURNS_ORG_RUN_ID_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
