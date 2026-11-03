import type { OnlineStepIntroduction } from "@/api/db/online-migration-connection";
import {
  publishedCaseLawDecisionIndexDefinitionPredicateSql,
  publishedCaseLawDecisionIndexPredicateSql,
} from "@/api/lib/case-law/published-decisions-sql";
import type { RequiredMigrationIndex } from "@/api/lib/db/migration-history";

export const CASE_LAW_COURT_DATE_PUBLISHED_INDEX = {
  introducedBy: { type: "code", owner: "src/lib/case-law/court-date-index.ts" },
  createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_country_court_date_published_idx" ON public."case_law_decisions" USING btree ("country", "court", coalesce("decision_date", '-infinity'::date), "id") WHERE ${publishedCaseLawDecisionIndexPredicateSql()}`,
  definitionBody: `ON public.case_law_decisions USING btree (country, court, COALESCE(decision_date, '-infinity'::date), id) WHERE ${publishedCaseLawDecisionIndexDefinitionPredicateSql()}`,
  isUnique: false,
  name: "case_law_decisions_country_court_date_published_idx",
  tableName: "case_law_decisions",
} as const satisfies RequiredMigrationIndex & {
  createSql: string;
  introducedBy: OnlineStepIntroduction;
};
