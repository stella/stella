import { LIST_GENERATION_CONSTRAINT_VALIDATIONS } from "../list-generation-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-list-generation-constraint-validations",
  revision: 1428,
  type: "repairs",
  values: [...LIST_GENERATION_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
