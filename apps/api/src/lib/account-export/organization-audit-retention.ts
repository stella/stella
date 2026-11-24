import type { Transaction } from "@/api/db/types";
import {
  lockReadyOrganizationAuditExport,
  retainOrganizationAuditExport,
} from "@/api/lib/account-export/store";
import type { SafeId } from "@/api/lib/branded-types";

type RetainOrganizationAuditArchiveOptions = {
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
 * Keeps the deleting owner's ready archive of this organization's audit
 * trail for a full retention window from now, so it outlives the
 * organization it describes. The archive is the owner's account data, keyed
 * by their account. Deletion does not require one: the owner decides, and
 * the web confirmation recommends taking it first.
 *
 * Runs inside the deletion transaction. The archive row is locked first (the
 * registered order puts account exports before organizations), so it cannot
 * expire underneath the deletion; the organization lock then fences the
 * trail the cascade removes.
 */
export const retainOrganizationAuditArchive = async ({
  tx,
  organizationId,
  userId,
  lockOrganization,
}: RetainOrganizationAuditArchiveOptions): Promise<void> => {
  const archive = await lockReadyOrganizationAuditExport(tx, {
    organizationId,
    userId,
  });

  await lockOrganization();

  if (archive !== undefined) {
    await retainOrganizationAuditExport(tx, archive);
  }
};
