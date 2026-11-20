import { caseNumberMatchKeyDdl } from "@/api/lib/case-law/case-number-match-key";

import type { OnlineMigrationEntry } from "../online-migration-entry";

const MATCH_KEY = caseNumberMatchKeyDdl('"citation_key"');

export default {
  id: "indexes-case-law-citations-reopenable-match-key-idx",
  revision: 1499,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261119215600_case_number_match_key_indexes",
      createSql: `CREATE INDEX CONCURRENTLY "case_law_citations_reopenable_match_key_idx" ON public."case_law_citations" USING btree ((${MATCH_KEY})) WHERE "resolution_status" IN ('unmatched', 'ambiguous')`,
      definitionBody: String.raw`ON public.case_law_citations USING btree (regexp_replace((citation_key)::text, '/(?:19|20)([0-9]{2})(-[0-9]+)?$'::text, '/\1\2'::text)) WHERE (resolution_status = ANY (ARRAY['unmatched'::text, 'ambiguous'::text]))`,
      isUnique: false,
      name: "case_law_citations_reopenable_match_key_idx",
      tableName: "case_law_citations",
    },
  ],
} satisfies OnlineMigrationEntry;
