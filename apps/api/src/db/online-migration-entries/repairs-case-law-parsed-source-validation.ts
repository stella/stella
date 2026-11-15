import { CASE_LAW_PARSED_SOURCE_VALIDATION } from "../case-law-parsed-source-hash-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-case-law-parsed-source-validation",
  revision: 990,
  type: "repairs",
  values: [CASE_LAW_PARSED_SOURCE_VALIDATION],
} satisfies OnlineMigrationEntry;
