import { caseNumberMatchKeyDdl } from "@/api/lib/case-law/case-number-match-key";
import {
  publishedCaseLawDecisionIndexDefinitionPredicateSql,
  publishedCaseLawDecisionIndexPredicateSql,
} from "@/api/lib/case-law/published-decisions-sql";

import type { OnlineMigrationEntry } from "../online-migration-entry";

const MATCH_KEY = caseNumberMatchKeyDdl('"citation_key"');
const MATCH_KEY_DEFINITION = String.raw`regexp_replace((citation_key)::text, '/(?:19|20)([0-9]{2})(-[0-9]+)?$'::text, '/\1\2'::text)`;
const PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE =
  publishedCaseLawDecisionIndexPredicateSql();
const PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION =
  publishedCaseLawDecisionIndexDefinitionPredicateSql();

export default {
  id: "indexes-case-law-decisions-citation-match-key-published-idx",
  revision: 1498,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261119215600_case_number_match_key_indexes",
      createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_citation_match_key_published_idx" ON public."case_law_decisions" USING btree ((${MATCH_KEY}), "country", "decision_date", "id") WHERE "citation_key" IS NOT NULL AND ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
      definitionBody: `ON public.case_law_decisions USING btree (${MATCH_KEY_DEFINITION}, country, decision_date, id) WHERE ((citation_key IS NOT NULL) AND ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION})`,
      isUnique: false,
      name: "case_law_decisions_citation_match_key_published_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
