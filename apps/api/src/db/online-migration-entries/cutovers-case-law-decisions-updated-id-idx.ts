import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "cutovers-case-law-decisions-updated-id-idx",
  revision: 770,
  type: "cutovers",
  values: [
    {
      introducedBy: "20260801150000_document_processing_queue_nulls_first",
      final: {
        definitionBody:
          "ON public.case_law_decisions USING btree (updated_at DESC, id DESC)",
        introducedBy: "20260801150000_document_processing_queue_nulls_first",
        isUnique: false,
        name: "case_law_decisions_updated_id_idx",
        tableName: "case_law_decisions",
      },
      legacy: {
        definitionBody:
          "ON public.case_law_decisions USING btree (updated_at, id)",
        isUnique: false,
        name: "case_law_decisions_updated_id_idx",
        tableName: "case_law_decisions",
      },
      staged: {
        createSql:
          'CREATE INDEX CONCURRENTLY "case_law_decisions_updated_id_idx_replacement" ON public."case_law_decisions" USING btree ("updated_at" DESC, "id" DESC)',
        definitionBody:
          "ON public.case_law_decisions USING btree (updated_at DESC, id DESC)",
        introducedBy: "20260801150000_document_processing_queue_nulls_first",
        isUnique: false,
        name: "case_law_decisions_updated_id_idx_replacement",
        tableName: "case_law_decisions",
      },
    },
  ],
} satisfies OnlineMigrationEntry;
