import { SITEMAP_MONTH_INDEX } from "../case-law-sitemap-indexes";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-decisions-sitemap-month-published-idx",
  revision: 1413,
  type: "indexes",
  values: [SITEMAP_MONTH_INDEX],
} satisfies OnlineMigrationEntry;
