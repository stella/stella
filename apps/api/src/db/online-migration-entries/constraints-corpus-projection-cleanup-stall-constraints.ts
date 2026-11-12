import { CORPUS_PROJECTION_CLEANUP_STALL_CONSTRAINTS } from "../corpus-projection-cleanup-stall-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-corpus-projection-cleanup-stall-constraints",
  revision: 1390,
  type: "constraints",
  values: [...CORPUS_PROJECTION_CLEANUP_STALL_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
