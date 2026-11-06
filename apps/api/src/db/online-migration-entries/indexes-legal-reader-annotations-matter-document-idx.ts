import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-legal-reader-annotations-matter-document-idx",
  revision: 100,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      // Lists a matter document's marks and serves the document cleanup
      // trigger; both still work, by a scan, until it exists.
      createSql:
        'CREATE INDEX CONCURRENTLY "legal_reader_annotations_matter_document_idx" ON public."legal_reader_annotations" (workspace_id, entity_id, created_at, id) WHERE entity_id IS NOT NULL',
      definitionBody:
        "ON public.legal_reader_annotations USING btree (workspace_id, entity_id, created_at, id) WHERE (entity_id IS NOT NULL)",
      isUnique: false,
      name: "legal_reader_annotations_matter_document_idx",
      tableName: "legal_reader_annotations",
    },
  ],
} satisfies OnlineMigrationEntry;
