import { CASE_LAW_SITEMAP_RANGE_BOUNDS_CONSTRAINT } from "../case-law-sitemap-packing-enrollment";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-case-law-sitemap-range-bounds",
  revision: 1469,
  type: "constraints",
  values: [CASE_LAW_SITEMAP_RANGE_BOUNDS_CONSTRAINT],
} satisfies OnlineMigrationEntry;
