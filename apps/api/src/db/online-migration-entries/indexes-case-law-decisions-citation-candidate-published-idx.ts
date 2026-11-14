import {
  publishedCaseLawDecisionIndexDefinitionPredicateSql,
  publishedCaseLawDecisionIndexPredicateSql,
} from "@/api/lib/case-law/published-decisions-sql";

import type { OnlineMigrationEntry } from "../online-migration-entry";

const PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE =
  publishedCaseLawDecisionIndexPredicateSql();
const PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION =
  publishedCaseLawDecisionIndexDefinitionPredicateSql();

export default {
  id: "indexes-case-law-decisions-citation-candidate-published-idx",
  revision: 260,
  type: "indexes",
  values: [
    {
      createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_citation_candidate_published_idx" ON public."case_law_decisions" USING btree ("citation_key", "country", "decision_date", "id") WHERE "citation_key" IS NOT NULL AND ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
      definitionBody: `ON public.case_law_decisions USING btree (citation_key, country, decision_date, id) WHERE ((citation_key IS NOT NULL) AND ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION})`,
      introducedBy: "20261010212100_case_law_publication_filter",
      isUnique: false,
      name: "case_law_decisions_citation_candidate_published_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
