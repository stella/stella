import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-decisions-docket-family-key-idx",
  revision: 510,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_decisions_docket_family_key_idx" ON public."case_law_decisions" USING btree ("docket_family_key") WHERE "docket_family_key" IS NOT NULL',
      definitionBody:
        "ON public.case_law_decisions USING btree (docket_family_key) WHERE (docket_family_key IS NOT NULL)",
      introducedBy: "20261003123300_case_law_decision_docket_family_key",
      isUnique: false,
      name: "case_law_decisions_docket_family_key_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
