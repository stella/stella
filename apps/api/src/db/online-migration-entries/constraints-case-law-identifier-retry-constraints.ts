import { CASE_LAW_IDENTIFIER_RETRY_CONSTRAINTS } from "../case-law-identifier-retry-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-case-law-identifier-retry-constraints",
  revision: 1250,
  type: "constraints",
  values: [...CASE_LAW_IDENTIFIER_RETRY_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
