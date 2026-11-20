import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-decisions-source-content-changed-idx",
  revision: 1489,
  lifecycle: "pending",
  type: "indexes",
  values: [
    {
      introducedBy: "20261117160000_case_law_content_changed_at",
      createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_source_content_changed_idx" ON public."case_law_decisions" USING btree ("source_id", "content_changed_at", "id") WHERE "content_changed_at" IS NOT NULL`,
      definitionBody:
        "ON public.case_law_decisions USING btree (source_id, content_changed_at, id) WHERE (content_changed_at IS NOT NULL)",
      isUnique: false,
      name: "case_law_decisions_source_content_changed_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
