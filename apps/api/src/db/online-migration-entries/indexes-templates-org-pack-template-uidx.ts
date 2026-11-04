import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-templates-org-pack-template-uidx",
  revision: 630,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.TEMPLATES_ORG_PACK_TEMPLATE_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
