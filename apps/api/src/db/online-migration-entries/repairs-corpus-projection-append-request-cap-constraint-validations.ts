import { CORPUS_PROJECTION_APPEND_REQUEST_CAP_CONSTRAINT_VALIDATIONS } from "../corpus-projection-append-request-cap-constraints";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-corpus-projection-append-request-cap-constraint-validations",
  revision: 1609,
  lifecycle: "pending",
  type: "repairs",
  values: [...CORPUS_PROJECTION_APPEND_REQUEST_CAP_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
