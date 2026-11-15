import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-provision-extractions-clock-seed-idx",
  revision: 480,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_provision_extractions_clock_seed_idx" ON public."case_law_provision_extractions" USING btree ("decision_id") WHERE "due_at" IS NOT NULL AND "pending_since" IS NULL',
      definitionBody:
        "ON public.case_law_provision_extractions USING btree (decision_id) WHERE ((due_at IS NOT NULL) AND (pending_since IS NULL))",
      introducedBy: "20261010110000_case_law_provision_pending_since",
      isUnique: false,
      name: "case_law_provision_extractions_clock_seed_idx",
      tableName: "case_law_provision_extractions",
    },
  ],
} satisfies OnlineMigrationEntry;
