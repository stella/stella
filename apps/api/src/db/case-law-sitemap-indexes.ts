import {
  publishedCaseLawDecisionIndexDefinitionPredicateSql,
  publishedCaseLawDecisionIndexPredicateSql,
} from "@/api/lib/case-law/published-decisions-sql";

const PUBLISHED_PREDICATE = publishedCaseLawDecisionIndexPredicateSql();
const PUBLISHED_DEFINITION =
  publishedCaseLawDecisionIndexDefinitionPredicateSql();

/**
 * The two indexes a sitemap month rides: the month's decisions, and the
 * language group each of them probes. Together they carry everything the
 * month's count reads, so it visits no heap page of an all-visible table.
 */
export const SITEMAP_MONTH_INDEX = {
  name: "case_law_decisions_sitemap_month_published_idx",
  introducedBy: "20261105210000_case_law_sitemap_covering_indexes",
  tableName: "case_law_decisions",
  createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_sitemap_month_published_idx" ON public."case_law_decisions" USING btree ("country", "decision_date", "source_id", "updated_at", "id", "language_group_key", "language") WHERE ${PUBLISHED_PREDICATE}`,
  definitionBody: `ON public.case_law_decisions USING btree (country, decision_date, source_id, updated_at, id, language_group_key, language) WHERE ${PUBLISHED_DEFINITION}`,
  isUnique: false,
} as const;

export const SITEMAP_LANGUAGE_GROUP_INDEX = {
  name: "case_law_decisions_language_group_published_idx",
  introducedBy: "20261105210000_case_law_sitemap_covering_indexes",
  tableName: "case_law_decisions",
  createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_language_group_published_idx" ON public."case_law_decisions" USING btree ("country", "language_group_key", "id", "language", "source_id") WHERE ${PUBLISHED_PREDICATE}`,
  definitionBody: `ON public.case_law_decisions USING btree (country, language_group_key, id, language, source_id) WHERE ${PUBLISHED_DEFINITION}`,
  isUnique: false,
} as const;
