import { AGENT_SKILL_BINDING_CONSTRAINT_VALIDATIONS } from "../agent-skill-binding-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-agent-skill-binding-constraint-validations",
  revision: 1010,
  type: "repairs",
  values: [...AGENT_SKILL_BINDING_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
