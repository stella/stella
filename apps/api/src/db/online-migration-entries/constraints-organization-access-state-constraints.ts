import type { OnlineMigrationEntry } from "../online-migration-entry";
import { ORGANIZATION_ACCESS_STATE_CONSTRAINTS } from "../organization-access-state-constraint-validation";

export default {
  id: "constraints-organization-access-state-constraints",
  revision: 1320,
  type: "constraints",
  values: [...ORGANIZATION_ACCESS_STATE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
