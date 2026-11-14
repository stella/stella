import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-time-entries-one-active-timer-per-user-idx",
  revision: 590,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.TIME_ENTRIES_ONE_ACTIVE_TIMER_PER_USER_IDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
