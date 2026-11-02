import { LEGISLATION_MATTER_LINK_CONSTRAINTS } from "../legislation-matter-link-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-legislation-matter-link-constraints",
  revision: 1355,
  type: "constraints",
  values: [...LEGISLATION_MATTER_LINK_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
