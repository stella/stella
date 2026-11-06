import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-decisions-ecli-upper-idx",
  revision: 1415,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_decisions_ecli_upper_idx" ON public."case_law_decisions" USING btree (upper("ecli")) WHERE "ecli" IS NOT NULL',
      definitionBody:
        "ON public.case_law_decisions USING btree (upper((ecli)::text)) WHERE (ecli IS NOT NULL)",
      introducedBy: "20261106160000_case_law_ecli_upper_index",
      isUnique: false,
      name: "case_law_decisions_ecli_upper_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
