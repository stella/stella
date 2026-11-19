import { caseNumberMatchKeyDdl } from "@/api/lib/case-law/case-number-match-key";

import type { OnlineMigrationEntry } from "../online-migration-entry";

const MATCH_KEY = caseNumberMatchKeyDdl('"normalized_value"');

export default {
  id: "indexes-case-law-decision-identifiers-match-key-idx",
  revision: 1496,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261119215600_case_number_match_key_indexes",
      createSql: `CREATE INDEX CONCURRENTLY "case_law_decision_identifiers_match_key_idx" ON public."case_law_decision_identifiers" USING btree ("type", (${MATCH_KEY}), "decision_id")`,
      definitionBody: String.raw`ON public.case_law_decision_identifiers USING btree (type, regexp_replace((normalized_value)::text, '/(?:19|20)([0-9]{2})(-[0-9]+)?$'::text, '/\1\2'::text), decision_id)`,
      isUnique: false,
      name: "case_law_decision_identifiers_match_key_idx",
      tableName: "case_law_decision_identifiers",
    },
  ],
} satisfies OnlineMigrationEntry;
