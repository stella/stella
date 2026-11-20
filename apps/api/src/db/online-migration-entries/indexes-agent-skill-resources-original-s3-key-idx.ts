import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-agent-skill-resources-original-s3-key-idx",
  revision: 1504,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261120070100_agent_skill_resource_originals",
      createSql: `CREATE INDEX CONCURRENTLY "agent_skill_resources_original_s3_key_idx" ON public."agent_skill_resources" USING btree ("original_s3_key") WHERE "original_s3_key" IS NOT NULL`,
      definitionBody:
        "ON public.agent_skill_resources USING btree (original_s3_key) WHERE (original_s3_key IS NOT NULL)",
      isUnique: false,
      name: "agent_skill_resources_original_s3_key_idx",
      tableName: "agent_skill_resources",
    },
  ],
} satisfies OnlineMigrationEntry;
