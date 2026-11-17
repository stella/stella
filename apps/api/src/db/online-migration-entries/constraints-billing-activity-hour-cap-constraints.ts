import { BILLING_ACTIVITY_HOUR_CAP_CONSTRAINTS } from "../billing-activity-hour-cap-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-billing-activity-hour-cap-constraints",
  revision: 1360,
  lifecycle: "finalized",
  type: "constraints",
  values: [...BILLING_ACTIVITY_HOUR_CAP_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
