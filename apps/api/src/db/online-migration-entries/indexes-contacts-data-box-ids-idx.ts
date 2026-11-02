import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-contacts-data-box-ids-idx",
  revision: 765,
  type: "indexes",
  values: [
    {
      createSql: `CREATE INDEX CONCURRENTLY "contacts_data_box_ids_idx" ON public."contacts" USING gin (("metadata" -> 'dataBoxes') jsonb_path_ops)`,
      definitionBody:
        "ON public.contacts USING gin (((metadata -> 'dataBoxes'::text)) jsonb_path_ops)",
      introducedBy: "20261031235000_data_box_correspondence",
      isUnique: false,
      name: "contacts_data_box_ids_idx",
      tableName: "contacts",
    },
  ],
} satisfies OnlineMigrationEntry;
