import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-chat-thread-compactions-memory-unmined-org-idx",
  revision: 530,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "chat_thread_compactions_memory_unmined_org_idx" ON public."chat_thread_compactions" USING btree ("memory_extraction_organization_id", "memory_extraction_consent_at", "memory_extraction_attempted_at" ASC NULLS FIRST, "created_at", "id") WHERE "memory_extraction_organization_id" IS NOT NULL AND "memory_extraction_consent_at" IS NOT NULL AND "memory_extracted_at" IS NULL AND "status" = \'active\'',
      definitionBody:
        "ON public.chat_thread_compactions USING btree (memory_extraction_organization_id, memory_extraction_consent_at, memory_extraction_attempted_at NULLS FIRST, created_at, id) WHERE ((memory_extraction_organization_id IS NOT NULL) AND (memory_extraction_consent_at IS NOT NULL) AND (memory_extracted_at IS NULL) AND ((status)::text = 'active'::text))",
      introducedBy: "20260808006000_ai_memory_extractor_index",
      isUnique: false,
      name: "chat_thread_compactions_memory_unmined_org_idx",
      tableName: "chat_thread_compactions",
    },
  ],
} satisfies OnlineMigrationEntry;
