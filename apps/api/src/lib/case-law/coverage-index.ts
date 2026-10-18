import {
  publishedCaseLawDecisionIndexDefinitionPredicateSql,
  publishedCaseLawDecisionIndexPredicateSql,
} from "@/api/lib/case-law/published-decisions-sql";
import type { RequiredMigrationIndex } from "@/api/lib/db/migration-history";

export const CASE_LAW_COVERAGE_INDEX = {
  createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_source_decision_date_coverage_idx" ON public."case_law_decisions" USING btree ("source_id", "decision_date", "id") WHERE ${publishedCaseLawDecisionIndexPredicateSql()}`,
  definitionBody: `ON public.case_law_decisions USING btree (source_id, decision_date, id) WHERE ${publishedCaseLawDecisionIndexDefinitionPredicateSql()}`,
  isUnique: false,
  name: "case_law_decisions_source_decision_date_coverage_idx",
  tableName: "case_law_decisions",
} as const satisfies RequiredMigrationIndex & { createSql: string };
