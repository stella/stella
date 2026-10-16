import { publishedUnredactedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions-sql";
import type { IntroducedMigrationIndex } from "@/api/lib/db/migration-history";

export const CASE_LAW_COVERAGE_INDEX = {
  createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_source_decision_date_coverage_idx" ON public."case_law_decisions" USING btree ("source_id", "decision_date", "id") WHERE ${publishedUnredactedCaseLawDecisionSqlFor("case_law_decisions")}`,
  definitionBody:
    "ON public.case_law_decisions USING btree (source_id, decision_date, id) WHERE ((redacted_at IS NULL) AND (jsonb_extract_path_text(metadata, VARIADIC ARRAY['_stellaPartialObservation'::text, 'isListingOnly'::text]) IS DISTINCT FROM 'true'::text))",
  introducedBy: "20261011005000_analysis_provider_diagnostic",
  isUnique: false,
  name: "case_law_decisions_source_decision_date_coverage_idx",
  tableName: "case_law_decisions",
} as const satisfies IntroducedMigrationIndex & { createSql: string };
