import { SITEMAP_RANGE_INDEX } from "../case-law-sitemap-indexes";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-decisions-country-date-published-idx",
  revision: 240,
  type: "indexes",
  values: [SITEMAP_RANGE_INDEX],
} satisfies OnlineMigrationEntry;
