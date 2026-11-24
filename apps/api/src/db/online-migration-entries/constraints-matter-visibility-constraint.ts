import { MATTER_VISIBILITY_CONSTRAINT } from "../matter-visibility-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-matter-visibility-constraint",
  revision: 1601,
  lifecycle: "pending",
  type: "constraints",
  values: [MATTER_VISIBILITY_CONSTRAINT],
} satisfies OnlineMigrationEntry;
