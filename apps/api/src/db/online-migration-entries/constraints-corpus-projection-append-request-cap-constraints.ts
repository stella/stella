import { CORPUS_PROJECTION_APPEND_REQUEST_CAP_CONSTRAINTS } from "../corpus-projection-append-request-cap-constraints";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-corpus-projection-append-request-cap-constraints",
  revision: 1608,
  lifecycle: "pending",
  type: "constraints",
  values: [...CORPUS_PROJECTION_APPEND_REQUEST_CAP_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
