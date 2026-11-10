import { LIST_CLAIM_QUALIFIERS_CONSTRAINTS } from "../list-claim-qualifiers-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-list-claim-qualifiers-constraints",
  revision: 1430,
  type: "constraints",
  values: [...LIST_CLAIM_QUALIFIERS_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
