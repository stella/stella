import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-workspace-views-correspondence-uidx",
  revision: 640,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.WORKSPACE_VIEWS_CORRESPONDENCE_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
