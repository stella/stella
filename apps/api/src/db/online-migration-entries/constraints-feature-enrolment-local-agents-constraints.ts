import { FEATURE_ENROLMENT_LOCAL_AGENTS_CONSTRAINTS } from "../feature-enrolment-local-agents-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-feature-enrolment-local-agents-constraints",
  revision: 1402,
  type: "constraints",
  values: [...FEATURE_ENROLMENT_LOCAL_AGENTS_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
