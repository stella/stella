import { CORPUS_PROJECTION_STORED_REVISION_WAKE_REPAIR } from "../corpus-projection-stored-revision-wake-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-corpus-projection-stored-revision-wake",
  revision: 1608,
  lifecycle: "finalized",
  type: "repairs",
  values: [CORPUS_PROJECTION_STORED_REVISION_WAKE_REPAIR],
} satisfies OnlineMigrationEntry;
