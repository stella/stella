import { FOLIO_COLLAB_CHECKPOINT_CONSTRAINTS } from "../folio-collab-checkpoint-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-folio-collab-checkpoint-constraints",
  revision: 1456,
  type: "constraints",
  values: [...FOLIO_COLLAB_CHECKPOINT_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
