import { DATA_BOX_CONSTRAINTS } from "../data-box-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-data-box-constraints",
  revision: 1400,
  type: "constraints",
  values: [...DATA_BOX_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
