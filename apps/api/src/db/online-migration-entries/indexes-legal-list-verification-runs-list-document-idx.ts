import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-legal-list-verification-runs-list-document-idx",
  revision: 1455,
  type: "indexes",
  values: [
    {
      introducedBy: "20261112160300_legal_list_verification_runs_list_index",
      createSql: `CREATE INDEX CONCURRENTLY "legal_list_verification_runs_list_document_idx" ON public."legal_list_verification_runs" USING btree ("workspace_id", ("evidence" ->> 'listId'), "entity_id", "file_field_id", "created_at" DESC, "id" DESC) WHERE "status" = 'completed'`,
      definitionBody:
        "ON public.legal_list_verification_runs USING btree (workspace_id, ((evidence ->> 'listId'::text)), entity_id, file_field_id, created_at DESC, id DESC) WHERE (status = 'completed'::text)",
      isUnique: false,
      name: "legal_list_verification_runs_list_document_idx",
      tableName: "legal_list_verification_runs",
    },
  ],
} satisfies OnlineMigrationEntry;
