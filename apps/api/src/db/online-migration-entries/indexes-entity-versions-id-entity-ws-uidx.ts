import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-entity-versions-id-entity-ws-uidx",
  revision: 560,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.ENTITY_VERSIONS_ID_ENTITY_WS_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
