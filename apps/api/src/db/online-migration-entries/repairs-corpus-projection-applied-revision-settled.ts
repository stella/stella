import { CORPUS_PROJECTION_APPLIED_REVISION_SETTLED_REPAIR } from "../corpus-projection-applied-revision-settled-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-corpus-projection-applied-revision-settled",
  revision: 1209,
  type: "repairs",
  values: [CORPUS_PROJECTION_APPLIED_REVISION_SETTLED_REPAIR],
} satisfies OnlineMigrationEntry;
