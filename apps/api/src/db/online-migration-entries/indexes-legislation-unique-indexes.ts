import type { OnlineMigrationEntry } from "../online-migration-entry";
import { LEGISLATION_UNIQUE_INDEXES } from "../online-unique-indexes";

export default {
  id: "indexes-legislation-unique-indexes",
  revision: 400,
  type: "indexes",
  values: [...LEGISLATION_UNIQUE_INDEXES],
} satisfies OnlineMigrationEntry;
