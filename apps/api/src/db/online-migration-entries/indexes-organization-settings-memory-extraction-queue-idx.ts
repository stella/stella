import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-organization-settings-memory-extraction-queue-idx",
  revision: 540,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "organization_settings_memory_extraction_queue_idx" ON public."organization_settings" USING btree ("memory_extraction_scheduled_at", "organization_id") WHERE "memory_extraction_enabled" = true AND "memory_extraction_scheduled_at" IS NOT NULL',
      definitionBody:
        "ON public.organization_settings USING btree (memory_extraction_scheduled_at, organization_id) WHERE ((memory_extraction_enabled = true) AND (memory_extraction_scheduled_at IS NOT NULL))",
      introducedBy: "20260808006000_ai_memory_extractor_index",
      isUnique: false,
      name: "organization_settings_memory_extraction_queue_idx",
      tableName: "organization_settings",
    },
  ],
} satisfies OnlineMigrationEntry;
