import type { OnlineMigrationEntry } from "../online-migration-entry";
import { SEARCH_HISTORY_COUNTRY_CONSTRAINT_VALIDATION } from "../search-history-country-constraint-validation";

export default {
  id: "repairs-search-history-country-constraint-validation",
  revision: 1425,
  type: "repairs",
  values: [SEARCH_HISTORY_COUNTRY_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
