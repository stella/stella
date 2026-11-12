import { LIST_CLAIM_ASSERTED_ON_CONSTRAINTS } from "../list-claim-asserted-on-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-list-claim-asserted-on-constraints",
  revision: 1452,
  type: "constraints",
  values: [...LIST_CLAIM_ASSERTED_ON_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
