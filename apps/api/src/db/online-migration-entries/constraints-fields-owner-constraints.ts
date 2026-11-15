import { FIELDS_OWNER_CONSTRAINTS } from "../fields-owner-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-fields-owner-constraints",
  revision: 1418,
  type: "constraints",
  values: [...FIELDS_OWNER_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
