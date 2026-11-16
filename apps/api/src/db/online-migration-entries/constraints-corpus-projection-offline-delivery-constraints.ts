import { CORPUS_PROJECTION_OFFLINE_DELIVERY_CONSTRAINTS } from "../corpus-projection-offline-delivery-constraints";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-corpus-projection-offline-delivery-constraints",
  revision: 1464,
  lifecycle: "pending",
  type: "constraints",
  values: [...CORPUS_PROJECTION_OFFLINE_DELIVERY_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
