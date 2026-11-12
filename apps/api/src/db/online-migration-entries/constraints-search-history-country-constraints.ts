import type { OnlineMigrationEntry } from "../online-migration-entry";
import { SEARCH_HISTORY_COUNTRY_CONSTRAINTS } from "../search-history-country-constraint-validation";

export default {
  id: "constraints-search-history-country-constraints",
  revision: 1439,
  type: "constraints",
  values: [...SEARCH_HISTORY_COUNTRY_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
