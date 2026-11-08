import { FILE_LIFECYCLE_CONSTRAINTS } from "../file-lifecycle-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-file-lifecycle-constraints",
  revision: 1391,
  type: "constraints",
  values: [...FILE_LIFECYCLE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
