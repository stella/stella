import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-provision-extractions-pending-idx",
  revision: 470,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_provision_extractions_pending_idx" ON public."case_law_provision_extractions" USING btree ("jurisdiction", "pending_since", "decision_id") WHERE "pending_since" IS NOT NULL',
      definitionBody:
        "ON public.case_law_provision_extractions USING btree (jurisdiction, pending_since, decision_id) WHERE (pending_since IS NOT NULL)",
      introducedBy: "20261010110000_case_law_provision_pending_since",
      isUnique: false,
      name: "case_law_provision_extractions_pending_idx",
      tableName: "case_law_provision_extractions",
    },
  ],
} satisfies OnlineMigrationEntry;
