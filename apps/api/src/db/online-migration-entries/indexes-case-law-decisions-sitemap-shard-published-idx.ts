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
  id: "indexes-case-law-decisions-sitemap-shard-published-idx",
  revision: 280,
  type: "indexes",
  values: [
    {
      createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_sitemap_shard_published_idx" ON public."case_law_decisions" USING btree ("country", "decision_date", "source_id", "updated_at", "id") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
      definitionBody: `ON public.case_law_decisions USING btree (country, decision_date, source_id, updated_at, id) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
      introducedBy: "20261010212100_case_law_publication_filter",
      isUnique: false,
      name: "case_law_decisions_sitemap_shard_published_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
