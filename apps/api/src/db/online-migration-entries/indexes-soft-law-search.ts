import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-soft-law-search",
  revision: 1426,
  type: "indexes",
  values: [
    {
      introducedBy: "20261108235000_soft_law_serving",
      createSql: `CREATE INDEX CONCURRENTLY "soft_law_documents_title_search_idx" ON public."soft_law_documents" USING gin (to_tsvector('simple'::regconfig, search_fold(title)))`,
      definitionBody:
        "ON public.soft_law_documents USING gin (to_tsvector('simple'::regconfig, search_fold(title)))",
      isUnique: false,
      name: "soft_law_documents_title_search_idx",
      tableName: "soft_law_documents",
    },
    {
      introducedBy: "20261108235000_soft_law_serving",
      createSql: `CREATE INDEX CONCURRENTLY "soft_law_versions_body_search_idx" ON public."soft_law_document_versions" USING gin (to_tsvector('simple'::regconfig, search_fold(left(extracted_text, 200000)))) WHERE observed_to IS NULL`,
      definitionBody:
        "ON public.soft_law_document_versions USING gin (to_tsvector('simple'::regconfig, search_fold(\"left\"(extracted_text, 200000)))) WHERE (observed_to IS NULL)",
      isUnique: false,
      name: "soft_law_versions_body_search_idx",
      tableName: "soft_law_document_versions",
    },
  ],
} satisfies OnlineMigrationEntry;
