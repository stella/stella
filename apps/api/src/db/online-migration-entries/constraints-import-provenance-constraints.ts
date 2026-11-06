import { IMPORT_PROVENANCE_CONSTRAINTS } from "../import-provenance-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-import-provenance-constraints",
  revision: 1395,
  type: "constraints",
  values: [...IMPORT_PROVENANCE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
