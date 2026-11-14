import { CORPUS_PROJECTION_CLEANUP_STALL_REPAIR } from "../corpus-projection-cleanup-stall-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-corpus-projection-cleanup-stall-repair",
  revision: 1180,
  type: "repairs",
  values: [CORPUS_PROJECTION_CLEANUP_STALL_REPAIR],
} satisfies OnlineMigrationEntry;
