import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-organization-file-objects-pending-reconcile-idx",
  revision: 911,
  type: "replacements",
  values: [
    {
      introducedBy: "20261101185803_file_reservation_reconciliation_state",
      legacyName: "organization_file_objects_pending_reconcile_idx",
      replacementNames: ["organization_file_objects_active_reconcile_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
