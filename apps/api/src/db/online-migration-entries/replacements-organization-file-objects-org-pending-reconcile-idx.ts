import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-organization-file-objects-org-pending-reconcile-idx",
  revision: 912,
  type: "replacements",
  values: [
    {
      introducedBy: "20261108083300_file_reservation_reconciliation_state",
      legacyName: "organization_file_objects_org_pending_reconcile_idx",
      replacementNames: ["organization_file_objects_org_active_reconcile_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
