import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-fields-workspace-file-sha256-idx",
  revision: 1505,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261120123000_fields_workspace_file_sha256_index",
      createSql: `CREATE INDEX CONCURRENTLY "fields_workspace_file_sha256_idx" ON public."fields" USING btree ("workspace_id", ("content" ->> 'sha256Hex'), "entity_version_id") WHERE "content" ->> 'type' = 'file'`,
      definitionBody:
        "ON public.fields USING btree (workspace_id, ((content ->> 'sha256Hex'::text)), entity_version_id) WHERE ((content ->> 'type'::text) = 'file'::text)",
      isUnique: false,
      name: "fields_workspace_file_sha256_idx",
      tableName: "fields",
    },
  ],
} satisfies OnlineMigrationEntry;
