import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-citations-polarity-pending-idx",
  revision: 1487,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261117140000_case_law_citations_polarity_pending_idx",
      createSql: `CREATE INDEX CONCURRENTLY "case_law_citations_polarity_pending_idx" ON public."case_law_citations" USING btree ("id") WHERE "polarity" IS NULL AND "kind" = 'precedent'`,
      definitionBody:
        "ON public.case_law_citations USING btree (id) WHERE ((polarity IS NULL) AND ((kind)::text = 'precedent'::text))",
      isUnique: false,
      name: "case_law_citations_polarity_pending_idx",
      tableName: "case_law_citations",
    },
  ],
} satisfies OnlineMigrationEntry;
