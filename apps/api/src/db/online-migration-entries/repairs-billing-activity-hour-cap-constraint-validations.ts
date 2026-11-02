import { BILLING_ACTIVITY_HOUR_CAP_CONSTRAINT_VALIDATIONS } from "../billing-activity-hour-cap-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-billing-activity-hour-cap-constraint-validations",
  revision: 1110,
  type: "repairs",
  values: [...BILLING_ACTIVITY_HOUR_CAP_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
