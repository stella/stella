import { FILE_OBJECT_RECONCILIATION_CONSTRAINTS } from "../file-object-reconciliation-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-file-object-reconciliation-constraints",
  revision: 1392,
  type: "constraints",
  values: [...FILE_OBJECT_RECONCILIATION_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
