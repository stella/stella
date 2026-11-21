import type { OnlineMigrationEntry } from "../online-migration-entry";
import { SESSION_SIGN_IN_LOCATION_CONSTRAINT } from "../session-sign-in-location-constraint-validation";

export default {
  id: "constraints-session-sign-in-location-constraint",
  revision: 1530,
  lifecycle: "pending",
  type: "constraints",
  values: [SESSION_SIGN_IN_LOCATION_CONSTRAINT],
} satisfies OnlineMigrationEntry;
