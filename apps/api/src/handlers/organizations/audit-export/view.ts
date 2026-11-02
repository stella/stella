import { accountExportStatus } from "@/api/lib/account-export/store";
import type { OrganizationAuditExportView } from "@/api/lib/account-export/store";

/**
 * The owner's audit archive of the active organization as the deletion flow
 * shows it. A ready archive says whether it still holds every audit row and
 * whether the owner has downloaded it, which organization deletion requires.
 */
export const organizationAuditExportView = ({
  row,
  coversCurrentTrail,
}: OrganizationAuditExportView) => {
  const status = accountExportStatus(row);
  return status.status === "ready"
    ? { ...status, coversCurrentTrail, downloaded: row.downloadedAt !== null }
    : status;
};
