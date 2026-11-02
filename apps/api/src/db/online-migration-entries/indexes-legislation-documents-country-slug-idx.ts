import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-legislation-documents-country-slug-idx",
  revision: 670,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "legislation_documents_country_slug_idx" ON public."legislation_documents" USING btree ("country", "slug") WHERE "slug" IS NOT NULL',
      definitionBody:
        "ON public.legislation_documents USING btree (country, slug) WHERE (slug IS NOT NULL)",
      introducedBy: "20260913220000_legislation_document_slugs",
      isUnique: false,
      name: "legislation_documents_country_slug_idx",
      tableName: "legislation_documents",
    },
  ],
} satisfies OnlineMigrationEntry;
