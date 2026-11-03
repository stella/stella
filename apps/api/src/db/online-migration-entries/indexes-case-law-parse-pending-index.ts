import { CASE_LAW_PARSE_PENDING_INDEX } from "../case-law-parsed-source-hash-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-parse-pending-index",
  revision: 50,
  type: "indexes",
  values: [CASE_LAW_PARSE_PENDING_INDEX],
} satisfies OnlineMigrationEntry;
