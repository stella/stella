import { CORPUS_PROJECTION_OFFLINE_FAULT_CONSTRAINT_VALIDATIONS } from "../corpus-projection-offline-fault-constraints";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-corpus-projection-offline-fault-constraint-validations",
  revision: 1469,
  lifecycle: "pending",
  type: "repairs",
  values: [...CORPUS_PROJECTION_OFFLINE_FAULT_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
