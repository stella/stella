import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-legislation-documents-work-version-lang-idx",
  revision: 80,
  type: "indexes",
  values: [
    {
      introducedBy: "20261019091000_legislation_publisher_identity",
      createSql:
        'CREATE INDEX CONCURRENTLY "legislation_documents_work_version_lang_idx" ON public."legislation_documents" (source_id, eli, version_valid_from, language) WHERE version_valid_from IS NOT NULL',
      definitionBody:
        "ON public.legislation_documents USING btree (source_id, eli, version_valid_from, language) WHERE (version_valid_from IS NOT NULL)",
      isUnique: false,
      name: "legislation_documents_work_version_lang_idx",
      tableName: "legislation_documents",
    },
  ],
} satisfies OnlineMigrationEntry;
