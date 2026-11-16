import { CORPUS_PROJECTION_OFFLINE_FAULT_CONSTRAINTS } from "../corpus-projection-offline-fault-constraints";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-corpus-projection-offline-fault-constraints",
  revision: 1468,
  lifecycle: "pending",
  type: "constraints",
  values: [...CORPUS_PROJECTION_OFFLINE_FAULT_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
