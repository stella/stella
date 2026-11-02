import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-playbook-definitions-org-starter-id-uidx",
  revision: 620,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.PLAYBOOK_DEFINITIONS_ORG_STARTER_ID_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
