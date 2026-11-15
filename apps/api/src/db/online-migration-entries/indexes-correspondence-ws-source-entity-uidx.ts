import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-correspondence-ws-source-entity-uidx",
  revision: 710,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.CORRESPONDENCE_WS_SOURCE_ENTITY_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
