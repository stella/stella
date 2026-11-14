import { SITEMAP_LANGUAGE_GROUP_INDEX } from "../case-law-sitemap-indexes";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-decisions-language-group-published-idx",
  revision: 1414,
  type: "indexes",
  values: [SITEMAP_LANGUAGE_GROUP_INDEX],
} satisfies OnlineMigrationEntry;
