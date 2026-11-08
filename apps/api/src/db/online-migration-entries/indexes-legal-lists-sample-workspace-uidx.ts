import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-legal-lists-sample-workspace-uidx",
  revision: 440,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.LEGAL_LISTS_SAMPLE_WORKSPACE_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
