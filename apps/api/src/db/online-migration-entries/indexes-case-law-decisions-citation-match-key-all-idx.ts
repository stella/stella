import { caseNumberMatchKeyDdl } from "@/api/lib/case-law/case-number-match-key";

import type { OnlineMigrationEntry } from "../online-migration-entry";

// Full, not partial: PostgreSQL keeps expression statistics only for the
// expressions of non-partial indexes, so this index is what gives every
// match-key comparison on decisions a real row estimate.
const MATCH_KEY = caseNumberMatchKeyDdl('"citation_key"');

export default {
  id: "indexes-case-law-decisions-citation-match-key-all-idx",
  revision: 1502,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261120003000_case_number_match_key_full_index",
      createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_citation_match_key_all_idx" ON public."case_law_decisions" USING btree ((${MATCH_KEY}), "country", "decision_date", "id")`,
      definitionBody: String.raw`ON public.case_law_decisions USING btree (regexp_replace((citation_key)::text, '/(?:19|20)([0-9]{2})(-[0-9]+)?$'::text, '/\1\2'::text), country, decision_date, id)`,
      isUnique: false,
      name: "case_law_decisions_citation_match_key_all_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
