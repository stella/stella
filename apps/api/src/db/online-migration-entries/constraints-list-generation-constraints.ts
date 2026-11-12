import { LIST_GENERATION_ONLINE_CONSTRAINTS } from "../list-generation-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-list-generation-constraints",
  revision: 1427,
  type: "constraints",
  values: [...LIST_GENERATION_ONLINE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
