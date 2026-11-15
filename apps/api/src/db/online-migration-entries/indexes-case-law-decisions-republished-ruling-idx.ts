import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-decisions-republished-ruling-idx",
  revision: 190,
  type: "indexes",
  // Bounded cross-publisher ruling lookup before a decision insert.
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_republished_ruling_idx" ON public."case_law_decisions" ("country", "court", "docket_family_key", "id") WHERE "docket_family_key" IS NOT NULL`,
      definitionBody:
        "ON public.case_law_decisions USING btree (country, court, docket_family_key, id) WHERE (docket_family_key IS NOT NULL)",
      isUnique: false,
      name: "case_law_decisions_republished_ruling_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
