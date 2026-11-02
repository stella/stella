import type { Transaction } from "@/api/db/root";
import {
  countOrganizationAuditRows,
  coversCurrentAuditTrail,
  lockReadyOrganizationAuditExport,
  retainOrganizationAuditExport,
} from "@/api/lib/account-export/store";
import type { SafeId } from "@/api/lib/branded-types";

/** Why an organization deletion cannot proceed yet. */
export const ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE = {
  /** The deleting owner holds no ready audit archive of this organization. */
  required: "organization_audit_export_required",
  /** The ready archive no longer holds every audit row of the organization. */
  stale: "organization_audit_export_stale",
  /** The deleting owner has not downloaded the ready archive. */
  notDownloaded: "organization_audit_export_not_downloaded",
} as const;

export type OrganizationAuditExportRefusalCode =
  (typeof ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE)[keyof typeof ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE];

/** What each refusal asks the owner to do. */
export const ORGANIZATION_AUDIT_EXPORT_REFUSAL_MESSAGE = {
  [ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE.required]:
    "Export the organization's activity log before deleting the organization.",
  [ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE.stale]:
    "Export the activity log again: it has new entries since the last export.",
  [ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE.notDownloaded]:
    "Download the activity log archive before deleting the organization.",
} as const satisfies Record<OrganizationAuditExportRefusalCode, string>;

export type OrganizationAuditExportGate =
  | { type: "covered"; exportId: string }
  | { type: "refused"; code: OrganizationAuditExportRefusalCode };

type RequireOrganizationAuditExportOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  /** The owner deleting the organization; only their own archive counts. */
  userId: SafeId<"user">;
  /**
   * Takes the organization row lock. Every audit insert takes a key-share
   * lock on that row through its foreign key, so once this returns no audit
   * write is in flight and none can start before the deletion commits.
   */
  lockOrganization: () => Promise<void>;
};

/**
 * The deletion precondition: the deleting owner's ready archive of this
 * organization's audit trail, holding every audit row the deletion removes,
 * which that owner has downloaded.
 *
 * Runs inside the deletion transaction. The archive row is locked first (the
 * registered order puts account exports before organizations), so it cannot
 * expire underneath the deletion; the organization lock then fences the trail
 * and the live count is compared with the archive's. The trail is append-only,
 * so equal counts mean the archive holds exactly the rows the cascade removes.
 *
 * A covered deletion extends the archive's expiry to a full retention window
 * from now: the archive is the owner's account data, keyed by their account,
 * and outlives the organization it describes.
 */
export const requireOrganizationAuditExport = async ({
  tx,
  organizationId,
  userId,
  lockOrganization,
}: RequireOrganizationAuditExportOptions): Promise<OrganizationAuditExportGate> => {
  const archive = await lockReadyOrganizationAuditExport(tx, {
    organizationId,
    userId,
  });

  await lockOrganization();

  if (archive === undefined) {
    return {
      type: "refused",
      code: ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE.required,
    };
  }
  if (
    !coversCurrentAuditTrail(
      archive,
      await countOrganizationAuditRows(tx, organizationId),
    )
  ) {
    return {
      type: "refused",
      code: ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE.stale,
    };
  }
  if (archive.downloadedAt === null) {
    return {
      type: "refused",
      code: ORGANIZATION_AUDIT_EXPORT_REFUSAL_CODE.notDownloaded,
    };
  }
  await retainOrganizationAuditExport(tx, archive);
  return { type: "covered", exportId: archive.id };
};
