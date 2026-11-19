import { caseNumberMatchKeyDdl } from "@/api/lib/case-law/case-number-match-key";

import type { OnlineMigrationEntry } from "../online-migration-entry";

const MATCH_KEY = caseNumberMatchKeyDdl('"citation_key"');

export default {
  id: "indexes-case-law-decisions-citation-match-key-idx",
  revision: 1497,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261119215600_case_number_match_key_indexes",
      createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_citation_match_key_idx" ON public."case_law_decisions" USING btree ((${MATCH_KEY}), "country", "decision_date", "id", "citation_key") WHERE "citation_key" IS NOT NULL`,
      definitionBody: String.raw`ON public.case_law_decisions USING btree (regexp_replace((citation_key)::text, '/(?:19|20)([0-9]{2})(-[0-9]+)?$'::text, '/\1\2'::text), country, decision_date, id, citation_key) WHERE (citation_key IS NOT NULL)`,
      isUnique: false,
      name: "case_law_decisions_citation_match_key_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
