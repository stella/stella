import { LIFECYCLE_SHAPE_CONSTRAINTS } from "../lifecycle-shape-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-lifecycle-shape-constraints",
  revision: 1416,
  type: "constraints",
  values: [...LIFECYCLE_SHAPE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
