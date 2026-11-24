import type { OnlineMigrationEntry } from "../online-migration-entry";
import { SESSION_SIGN_IN_LOCATION_CONSTRAINT_VALIDATION } from "../session-sign-in-location-constraint-validation";

export default {
  id: "repairs-session-sign-in-location-constraint-validation",
  revision: 1540,
  lifecycle: "pending",
  type: "repairs",
  values: [SESSION_SIGN_IN_LOCATION_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
