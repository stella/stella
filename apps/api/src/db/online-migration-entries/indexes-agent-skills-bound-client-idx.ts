import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-agent-skills-bound-client-idx",
  revision: 70,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql:
        'CREATE INDEX CONCURRENTLY "agent_skills_bound_client_idx" ON public."agent_skills" (bound_client_id) WHERE bound_client_id IS NOT NULL',
      definitionBody:
        "ON public.agent_skills USING btree (bound_client_id) WHERE (bound_client_id IS NOT NULL)",
      isUnique: false,
      name: "agent_skills_bound_client_idx",
      tableName: "agent_skills",
    },
  ],
} satisfies OnlineMigrationEntry;
