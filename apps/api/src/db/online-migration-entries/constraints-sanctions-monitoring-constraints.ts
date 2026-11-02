import type { OnlineMigrationEntry } from "../online-migration-entry";
import { SANCTIONS_MONITORING_CONSTRAINTS } from "../sanctions-monitoring-constraint-validation";

export default {
  id: "constraints-sanctions-monitoring-constraints",
  revision: 1300,
  type: "constraints",
  values: [...SANCTIONS_MONITORING_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
