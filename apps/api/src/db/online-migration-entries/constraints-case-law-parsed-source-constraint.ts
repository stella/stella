import { CASE_LAW_PARSED_SOURCE_CONSTRAINT } from "../case-law-parsed-source-hash-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-case-law-parsed-source-constraint",
  revision: 1240,
  type: "constraints",
  values: [CASE_LAW_PARSED_SOURCE_CONSTRAINT],
} satisfies OnlineMigrationEntry;
