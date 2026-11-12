import type { OnlineMigrationEntry } from "../online-migration-entry";
import { ORGANIZATION_AI_INSTRUCTIONS_CONSTRAINTS } from "../organization-ai-instructions-constraint-validation";

export default {
  id: "constraints-organization-ai-instructions-constraints",
  revision: 1431,
  type: "constraints",
  values: [...ORGANIZATION_AI_INSTRUCTIONS_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
