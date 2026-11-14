import { REWRITTEN_MIGRATION_INDEXES } from "../../lib/db/migration-history";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-rewritten-migration-indexes",
  revision: 760,
  type: "indexes",
  values: [...REWRITTEN_MIGRATION_INDEXES],
} satisfies OnlineMigrationEntry;
