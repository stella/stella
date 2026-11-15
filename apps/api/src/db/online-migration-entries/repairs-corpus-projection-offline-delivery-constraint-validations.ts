import { CORPUS_PROJECTION_OFFLINE_DELIVERY_CONSTRAINT_VALIDATIONS } from "../corpus-projection-offline-delivery-constraints";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-corpus-projection-offline-delivery-constraint-validations",
  revision: 1465,
  type: "repairs",
  values: [...CORPUS_PROJECTION_OFFLINE_DELIVERY_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
