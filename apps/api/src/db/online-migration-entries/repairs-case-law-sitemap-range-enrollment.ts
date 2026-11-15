import {
  CASE_LAW_SITEMAP_RANGE_BOUNDS_VALIDATION,
  CASE_LAW_SITEMAP_RANGE_ENROLLMENT,
} from "../case-law-sitemap-packing-enrollment";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-case-law-sitemap-range-enrollment",
  revision: 1468,
  type: "repairs",
  values: [
    CASE_LAW_SITEMAP_RANGE_ENROLLMENT,
    CASE_LAW_SITEMAP_RANGE_BOUNDS_VALIDATION,
  ],
} satisfies OnlineMigrationEntry;
