import type { OnlineStepIntroduction } from "@/api/db/online-migration-connection";
import {
  publishedCaseLawDecisionIndexDefinitionPredicateSql,
  publishedCaseLawDecisionIndexPredicateSql,
} from "@/api/lib/case-law/published-decisions-sql";
import type { RequiredMigrationIndex } from "@/api/lib/db/migration-history";

export const CASE_LAW_PROVISION_SEARCH_INDEX = {
  createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_country_authority_published_idx" ON public."case_law_decisions" USING btree ("country", "citation_authority" DESC, "id" DESC) WHERE ${publishedCaseLawDecisionIndexPredicateSql()}`,
  definitionBody: `ON public.case_law_decisions USING btree (country, citation_authority DESC, id DESC) WHERE ${publishedCaseLawDecisionIndexDefinitionPredicateSql()}`,
  introducedBy: {
    type: "code",
    owner: "src/lib/case-law/provision-search-index.ts",
  },
  isUnique: false,
  name: "case_law_decisions_country_authority_published_idx",
  tableName: "case_law_decisions",
} as const satisfies RequiredMigrationIndex & {
  createSql: string;
  introducedBy: OnlineStepIntroduction;
};
