import { LEGISLATION_MATTER_LINK_CONSTRAINT_VALIDATIONS } from "../legislation-matter-link-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-legislation-matter-link-constraint-validations",
  revision: 1105,
  type: "repairs",
  values: [...LEGISLATION_MATTER_LINK_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
