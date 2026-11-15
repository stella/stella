import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-citations-doctrine-cited-idx",
  revision: 160,
  type: "indexes",
  // Reviewed doctrine per cited decision: few rows carry a finding.
  values: [
    {
      createSql: `CREATE INDEX CONCURRENTLY "case_law_citations_doctrine_cited_idx" ON public."case_law_citations" USING btree ("cited_decision_id") WHERE "doctrinal_treatment" IN ('distinguishes', 'limits')`,
      definitionBody:
        "ON public.case_law_citations USING btree (cited_decision_id) WHERE ((doctrinal_treatment)::text = ANY ((ARRAY['distinguishes'::character varying, 'limits'::character varying])::text[]))",
      introducedBy: "20261014174500_case_law_citation_doctrine",
      isUnique: false,
      name: "case_law_citations_doctrine_cited_idx",
      tableName: "case_law_citations",
    },
  ],
} satisfies OnlineMigrationEntry;
