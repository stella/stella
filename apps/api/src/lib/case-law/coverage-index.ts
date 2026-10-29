import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  publishedCaseLawDecisionIndexDefinitionPredicateSql,
  publishedCaseLawDecisionIndexPredicateSql,
} from "@/api/lib/case-law/published-decisions-sql";
import type { IntroducedMigrationIndex } from "@/api/lib/db/migration-history";
import { decisionDateNotBeforeFilingYearSql } from "@/api/lib/decision-date-bounds-sql";

export const CASE_LAW_COVERAGE_INDEX = {
  createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_source_decision_date_coverage_idx" ON public."case_law_decisions" USING btree ("source_id", "decision_date", "id") WHERE ${publishedCaseLawDecisionIndexPredicateSql()}`,
  definitionBody: `ON public.case_law_decisions USING btree (source_id, decision_date, id) WHERE ${publishedCaseLawDecisionIndexDefinitionPredicateSql()}`,
  introducedBy: "20261011005000_analysis_provider_diagnostic",
  isUnique: false,
  name: "case_law_decisions_source_decision_date_coverage_idx",
  tableName: "case_law_decisions",
} as const satisfies IntroducedMigrationIndex & { createSql: string };

/** Sources without materialized facets aggregate published courts from this index alone. */
export const CASE_LAW_COVERAGE_COURT_INDEX = {
  createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_source_court_coverage_idx" ON public."case_law_decisions" USING btree ("source_id", "court") WHERE ${publishedCaseLawDecisionIndexPredicateSql()}`,
  definitionBody: `ON public.case_law_decisions USING btree (source_id, court) WHERE ${publishedCaseLawDecisionIndexDefinitionPredicateSql()}`,
  introducedBy: { type: "code", owner: "src/lib/case-law/coverage-index.ts" },
  isUnique: false,
  name: "case_law_decisions_source_court_coverage_idx",
  tableName: "case_law_decisions",
} as const satisfies IntroducedMigrationIndex & { createSql: string };

const FILING_DATE_PREDICATE_SQL = new PgDialect().sqlToQuery(
  decisionDateNotBeforeFilingYearSql({
    date: sql.identifier("decision_date"),
    country: sql.identifier("country"),
    caseNumber: sql.identifier("case_number"),
  }),
).sql;
// PostgreSQL flattens the AND and adds the numeric coercion in pg_get_indexdef.
const PUBLISHED_DEFINITION_TERMS =
  publishedCaseLawDecisionIndexDefinitionPredicateSql().slice(1, -1);
const FILING_DATE_DEFINITION_PREDICATE =
  "COALESCE((EXTRACT(year FROM decision_date) >= (((decision_docket_filing_year((case_number)::text, (country)::text) ->> 'year'::text))::integer)::numeric), true)";

/** Endpoint probes skip dates rejected by their docket's filing year without a heap walk. */
export const CASE_LAW_COVERAGE_FILING_DATE_INDEX = {
  createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_source_filing_date_coverage_idx" ON public."case_law_decisions" USING btree ("source_id", "decision_date", "id") WHERE ${publishedCaseLawDecisionIndexPredicateSql()} AND ${FILING_DATE_PREDICATE_SQL}`,
  definitionBody: `ON public.case_law_decisions USING btree (source_id, decision_date, id) WHERE (${PUBLISHED_DEFINITION_TERMS} AND ${FILING_DATE_DEFINITION_PREDICATE})`,
  introducedBy: { type: "code", owner: "src/lib/case-law/coverage-index.ts" },
  isUnique: false,
  name: "case_law_decisions_source_filing_date_coverage_idx",
  tableName: "case_law_decisions",
} as const satisfies IntroducedMigrationIndex & { createSql: string };
