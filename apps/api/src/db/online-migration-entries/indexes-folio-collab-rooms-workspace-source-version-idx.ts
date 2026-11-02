import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-folio-collab-rooms-workspace-source-version-idx",
  revision: 660,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "folio_collab_rooms_workspace_source_version_idx" ON public."folio_collab_rooms" USING btree ("workspace_id", "source_version_id")',
      definitionBody:
        "ON public.folio_collab_rooms USING btree (workspace_id, source_version_id)",
      introducedBy: "20260913100100_validate_folio_collab_source_version",
      isUnique: false,
      name: "folio_collab_rooms_workspace_source_version_idx",
      tableName: "folio_collab_rooms",
    },
  ],
} satisfies OnlineMigrationEntry;
