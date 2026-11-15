import type { OnlineMigrationEntry } from "../online-migration-entry";
import { ORGANIZATION_ACCESS_STATE_CONSTRAINT_VALIDATIONS } from "../organization-access-state-constraint-validation";

export default {
  id: "repairs-organization-access-state-constraint-validations",
  revision: 1070,
  type: "repairs",
  values: [...ORGANIZATION_ACCESS_STATE_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
