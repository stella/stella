import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";

/**
 * Serialize every contact writer for one organization before checking the
 * organization-wide contact limit. The transaction-scoped lock is released
 * automatically on commit or rollback.
 */
export const lockContactCapacity = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<void> => {
  await withAggregateLock({
    aggregate: "contactCapacity",
    id: { organizationId },
    tx,
  });
};
