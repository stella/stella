import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-provision-extractions-jurisdiction-due-idx",
  revision: 460,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_provision_extractions_jurisdiction_due_idx" ON public."case_law_provision_extractions" USING btree ("jurisdiction", "lane", "due_at", "decision_id") WHERE "due_at" IS NOT NULL AND "work_status" <> \'blocked\'',
      definitionBody:
        "ON public.case_law_provision_extractions USING btree (jurisdiction, lane, due_at, decision_id) WHERE ((due_at IS NOT NULL) AND (work_status <> 'blocked'::text))",
      introducedBy:
        "20261004120300_provision_extraction_jurisdiction_claim_index",
      isUnique: false,
      name: "case_law_provision_extractions_jurisdiction_due_idx",
      tableName: "case_law_provision_extractions",
    },
  ],
} satisfies OnlineMigrationEntry;
