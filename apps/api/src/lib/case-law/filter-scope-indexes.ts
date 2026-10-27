import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { decisionTypeKindSql } from "@/api/lib/case-law/decision-type-filter-sql";
import {
  publishedCaseLawDecisionIndexDefinitionPredicateSql,
  publishedCaseLawDecisionIndexPredicateSql,
} from "@/api/lib/case-law/published-decisions-sql";
import type { RequiredMigrationIndex } from "@/api/lib/db/migration-history";

const typeKindExpression = () =>
  new PgDialect().sqlToQuery(
    decisionTypeKindSql(sql.raw("decision_type")).inlineParams(),
  ).sql;

/** PostgreSQL's deparsed CASE layout; tested against pg_get_indexdef. */
const typeKindDefinition = () =>
  typeKindExpression()
    .replace(
      /^\(CASE lower\(decision_type\) /u,
      "\nCASE lower((decision_type)::text) ",
    )
    .replaceAll(" WHEN ", "\n    WHEN ")
    .replace(" ELSE ", "\n    ELSE ")
    .replace(/ END\)$/u, "\nEND");

export const CASE_LAW_FILTER_SCOPE_INDEXES = [
  {
    name: "case_law_decisions_country_type_kind_published_idx",
    tableName: "case_law_decisions",
    isUnique: false,
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_country_type_kind_published_idx" ON public."case_law_decisions" USING btree (country, ${typeKindExpression()}) WHERE ${publishedCaseLawDecisionIndexPredicateSql()}`,
    definitionBody: `ON public.case_law_decisions USING btree (country, (${typeKindDefinition()})) WHERE ${publishedCaseLawDecisionIndexDefinitionPredicateSql()}`,
  },
  {
    name: "case_law_decisions_country_type_stated_published_idx",
    tableName: "case_law_decisions",
    isUnique: false,
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_country_type_stated_published_idx" ON public."case_law_decisions" USING btree (country, lower(decision_type)) WHERE ${publishedCaseLawDecisionIndexPredicateSql()}`,
    definitionBody: `ON public.case_law_decisions USING btree (country, lower((decision_type)::text)) WHERE ${publishedCaseLawDecisionIndexDefinitionPredicateSql()}`,
  },
] as const satisfies readonly (RequiredMigrationIndex & {
  createSql: string;
})[];
