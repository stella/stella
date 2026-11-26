import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-citations-identifier-match-key-pending-idx",
  revision: 1606,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261125150000_case_law_citation_match_key",
      createSql: `CREATE INDEX CONCURRENTLY "case_law_citations_identifier_match_key_pending_idx" ON public."case_law_citations" USING btree ("id") WHERE "identifier_match_key" IS NULL AND coalesce("normalized_identifier_value", "citation_key") IS NOT NULL`,
      definitionBody:
        "ON public.case_law_citations USING btree (id) WHERE ((identifier_match_key IS NULL) AND (COALESCE(normalized_identifier_value, citation_key) IS NOT NULL))",
      isUnique: false,
      name: "case_law_citations_identifier_match_key_pending_idx",
      tableName: "case_law_citations",
    },
  ],
} satisfies OnlineMigrationEntry;
