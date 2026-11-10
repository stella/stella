import type { OnlineMigrationEntry } from "../online-migration-entry";
import { ORGANIZATION_AI_INSTRUCTIONS_CONSTRAINT_VALIDATIONS } from "../organization-ai-instructions-constraint-validation";

export default {
  id: "repairs-organization-ai-instructions-constraint-validations",
  revision: 1432,
  type: "repairs",
  values: [...ORGANIZATION_AI_INSTRUCTIONS_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
