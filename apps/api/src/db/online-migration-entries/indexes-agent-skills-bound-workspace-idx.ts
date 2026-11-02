import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-agent-skills-bound-workspace-idx",
  revision: 60,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql:
        'CREATE INDEX CONCURRENTLY "agent_skills_bound_workspace_idx" ON public."agent_skills" (bound_workspace_id) WHERE bound_workspace_id IS NOT NULL',
      definitionBody:
        "ON public.agent_skills USING btree (bound_workspace_id) WHERE (bound_workspace_id IS NOT NULL)",
      isUnique: false,
      name: "agent_skills_bound_workspace_idx",
      tableName: "agent_skills",
    },
  ],
} satisfies OnlineMigrationEntry;
