import type { OnlineMigrationEntry } from "../online-migration-entry";
import { SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS } from "../sanctions-monitoring-constraint-validation";

export default {
  id: "repairs-sanctions-monitoring-constraint-validations",
  revision: 1050,
  type: "repairs",
  values: [...SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
