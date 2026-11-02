import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-correspondence-attachments-ws-entity-idx",
  revision: 720,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "correspondence_attachments_ws_entity_idx" ON public."correspondence_attachments" USING btree ("workspace_id", "entity_id")',
      definitionBody:
        "ON public.correspondence_attachments USING btree (workspace_id, entity_id)",
      introducedBy: "20261004120100_uploaded_mail_correspondence",
      isUnique: false,
      name: "correspondence_attachments_ws_entity_idx",
      tableName: "correspondence_attachments",
    },
  ],
} satisfies OnlineMigrationEntry;
