import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-case-law-ingestion-failures-source-record-uidx",
  revision: 700,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.CASE_LAW_INGESTION_FAILURES_SOURCE_RECORD_UIDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
