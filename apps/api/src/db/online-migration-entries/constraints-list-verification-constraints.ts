import { LIST_VERIFICATION_CONSTRAINTS } from "../list-verification-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-list-verification-constraints",
  revision: 1310,
  type: "constraints",
  values: [...LIST_VERIFICATION_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
