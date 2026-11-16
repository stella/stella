import { LIFECYCLE_SHAPE_CONSTRAINT_VALIDATIONS } from "../lifecycle-shape-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-lifecycle-shape-constraint-validations",
  revision: 1421,
  lifecycle: "finalized",
  type: "repairs",
  values: [...LIFECYCLE_SHAPE_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
