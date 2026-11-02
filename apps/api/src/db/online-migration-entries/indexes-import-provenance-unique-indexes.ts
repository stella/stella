import type { OnlineMigrationEntry } from "../online-migration-entry";
import { IMPORT_PROVENANCE_UNIQUE_INDEXES } from "../online-unique-indexes";

export default {
  id: "indexes-import-provenance-unique-indexes",
  revision: 745,
  type: "indexes",
  values: [...IMPORT_PROVENANCE_UNIQUE_INDEXES],
} satisfies OnlineMigrationEntry;
