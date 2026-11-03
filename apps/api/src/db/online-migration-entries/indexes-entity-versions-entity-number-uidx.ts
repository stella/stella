import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-entity-versions-entity-number-uidx",
  revision: 570,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.ENTITY_VERSIONS_ENTITY_NUMBER_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
