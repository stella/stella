import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-contacts-org-id-unique",
  revision: 310,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.CONTACTS_ORG_ID_UNIQUE,
    ),
  ],
} satisfies OnlineMigrationEntry;
