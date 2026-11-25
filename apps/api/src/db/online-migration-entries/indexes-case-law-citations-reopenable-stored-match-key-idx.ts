import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-citations-reopenable-stored-match-key-idx",
  revision: 1604,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261125150000_case_law_citation_match_key",
      createSql: `CREATE INDEX CONCURRENTLY "case_law_citations_reopenable_stored_match_key_idx" ON public."case_law_citations" USING btree (coalesce("identifier_type", 'case-number'), "identifier_match_key") WHERE "resolution_status" IN ('unmatched', 'ambiguous')`,
      definitionBody:
        "ON public.case_law_citations USING btree (COALESCE(identifier_type, 'case-number'::character varying), identifier_match_key) WHERE (resolution_status = ANY (ARRAY['unmatched'::text, 'ambiguous'::text]))",
      isUnique: false,
      name: "case_law_citations_reopenable_stored_match_key_idx",
      tableName: "case_law_citations",
    },
  ],
} satisfies OnlineMigrationEntry;
