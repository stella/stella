import { FEATURE_ENROLMENT_LOCAL_AGENTS_CONSTRAINT_VALIDATIONS } from "../feature-enrolment-local-agents-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-feature-enrolment-local-agents-constraint-validations",
  revision: 1208,
  type: "repairs",
  values: [...FEATURE_ENROLMENT_LOCAL_AGENTS_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
