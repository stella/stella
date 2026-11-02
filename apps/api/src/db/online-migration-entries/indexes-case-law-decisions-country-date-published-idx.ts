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
  id: "indexes-case-law-decisions-country-date-published-idx",
  revision: 240,
  type: "indexes",
  values: [
    {
      createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_country_date_published_idx" ON public."case_law_decisions" USING btree ("country", coalesce("decision_date", '-infinity'::date), "id") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
      definitionBody: `ON public.case_law_decisions USING btree (country, COALESCE(decision_date, '-infinity'::date), id) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
      introducedBy: "20261010212100_case_law_publication_filter",
      isUnique: false,
      name: "case_law_decisions_country_date_published_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
