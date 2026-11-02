import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-file-comparison-uploads-org-user-idx",
  revision: 761,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "file_comparison_uploads_org_user_idx" ON public."file_comparison_uploads" USING btree ("organization_id", "user_id")',
      definitionBody:
        "ON public.file_comparison_uploads USING btree (organization_id, user_id)",
      isUnique: false,
      introducedBy: "20261101185703_file_comparison_claims",
      name: "file_comparison_uploads_org_user_idx",
      tableName: "file_comparison_uploads",
    },
  ],
} satisfies OnlineMigrationEntry;
