import type { OnlineMigrationEntry } from "../online-migration-entry";

// Billing guideline file search over knowledge-file paths.
export default {
  id: "indexes-agent-skill-resources-path-billing-trgm-idx",
  revision: 195,
  type: "indexes",
  values: [
    {
      introducedBy: "20261101221234_activity_billing_drafts",
      createSql:
        'CREATE INDEX CONCURRENTLY "agent_skill_resources_path_billing_trgm_idx" ON public."agent_skill_resources" USING gin ("path" gin_trgm_ops)',
      definitionBody:
        "ON public.agent_skill_resources USING gin (path gin_trgm_ops)",
      isUnique: false,
      name: "agent_skill_resources_path_billing_trgm_idx",
      tableName: "agent_skill_resources",
    },
  ],
} satisfies OnlineMigrationEntry;
