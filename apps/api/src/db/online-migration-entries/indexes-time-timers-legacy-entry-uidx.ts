import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-time-timers-legacy-entry-uidx",
  revision: 610,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.TIME_TIMERS_LEGACY_ENTRY_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
