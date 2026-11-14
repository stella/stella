import { DATA_BOX_CONSTRAINT_VALIDATIONS } from "../data-box-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-data-box-constraint-validations",
  revision: 1206,
  type: "repairs",
  values: [...DATA_BOX_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
