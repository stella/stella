import { IMPORT_PROVENANCE_CONSTRAINT_VALIDATIONS } from "../import-provenance-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-import-provenance-constraint-validations",
  revision: 1185,
  type: "repairs",
  values: [...IMPORT_PROVENANCE_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
