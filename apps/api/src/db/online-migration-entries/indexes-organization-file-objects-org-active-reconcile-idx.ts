import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-organization-file-objects-org-active-reconcile-idx",
  revision: 764,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "organization_file_objects_org_active_reconcile_idx" ON public."organization_file_objects" USING btree ("organization_id", "reconcile_after", "object_key") WHERE "write_id" IS NOT NULL AND "reconciliation_state" = \'active\'',
      definitionBody:
        "ON public.organization_file_objects USING btree (organization_id, reconcile_after, object_key) WHERE ((write_id IS NOT NULL) AND (reconciliation_state = 'active'::text))",
      isUnique: false,
      introducedBy: "20261101221634_file_reservation_reconciliation_state",
      name: "organization_file_objects_org_active_reconcile_idx",
      tableName: "organization_file_objects",
    },
  ],
} satisfies OnlineMigrationEntry;
