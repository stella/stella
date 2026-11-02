import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-style-sets-deletion-cleanup-idx",
  revision: 762,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "style_sets_deletion_cleanup_idx" ON public."style_sets" USING btree ("deletion_cleanup_attempt_count", "deleted_at", "id") WHERE "deleted_at" IS NOT NULL',
      definitionBody:
        "ON public.style_sets USING btree (deletion_cleanup_attempt_count, deleted_at, id) WHERE (deleted_at IS NOT NULL)",
      isUnique: false,
      introducedBy: "20261101185603_style_set_deletion_cleanup",
      name: "style_sets_deletion_cleanup_idx",
      tableName: "style_sets",
    },
  ],
} satisfies OnlineMigrationEntry;
