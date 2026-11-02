import { AGENT_SKILL_BINDING_CONSTRAINTS } from "../agent-skill-binding-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-agent-skill-binding-constraints",
  revision: 1260,
  type: "constraints",
  values: [...AGENT_SKILL_BINDING_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
