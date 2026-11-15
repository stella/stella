import { LIST_VERIFICATION_SCOPE_CONSTRAINTS } from "../list-verification-scope-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-list-verification-scope-constraints",
  revision: 1440,
  type: "constraints",
  values: [...LIST_VERIFICATION_SCOPE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
