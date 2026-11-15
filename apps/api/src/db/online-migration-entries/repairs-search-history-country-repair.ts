import type { OnlineMigrationEntry } from "../online-migration-entry";
import { SEARCH_HISTORY_COUNTRY_REPAIR } from "../search-history-country-repair";

export default {
  id: "repairs-search-history-country-repair",
  revision: 1437,
  type: "repairs",
  values: [SEARCH_HISTORY_COUNTRY_REPAIR],
} satisfies OnlineMigrationEntry;
